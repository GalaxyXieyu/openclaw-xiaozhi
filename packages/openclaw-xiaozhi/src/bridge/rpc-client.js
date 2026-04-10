import WebSocket from "ws";

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 15000;
const RECONNECT_STABLE_MS = 60000;
const RECONNECT_JITTER_RATIO = 0.2;
const REQUEST_TIMEOUT_MS = 30000;
const SUPPORTED_METHODS = new Set([
  "xiaozhi.sessionStarted",
  "xiaozhi.sessionEnded",
  "xiaozhi.chat",
  "xiaozhi.bindPeerAgent",
  "xiaozhi.inventory",
  "xiaozhi.clearPeerSession",
  "xiaozhi.debugSessionGet"
]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function applyReconnectJitter(delayMs) {
  const jitterWindow = Math.max(250, Math.round(delayMs * RECONNECT_JITTER_RATIO));
  const offset = Math.floor(Math.random() * (jitterWindow * 2 + 1)) - jitterWindow;
  return Math.max(RECONNECT_MIN_MS, delayMs + offset);
}

function buildBridgeUrl(serverUrl, bridgeToken) {
  const url = new URL(serverUrl);
  if (!url.searchParams.get("token") && bridgeToken) {
    url.searchParams.set("token", bridgeToken);
  }
  return url.toString();
}

function normalizeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    code: -32000,
    message
  };
}

function accountLogLabel(accountId, bridgeId) {
  return `account=${accountId} bridge=${bridgeId || "unknown"}`;
}

export class XiaozhiBridgeClient {
  constructor({ api, accountId, accountConfig, router }) {
    this.api = api;
    this.accountId = accountId;
    this.accountConfig = accountConfig;
    this.router = router;
    this.stopped = false;
    this.runTask = null;
    this.socket = null;
    this.nextRequestId = 1;
    this.pendingResults = new Map();
  }

  async start() {
    if (this.runTask) {
      return;
    }
    this.stopped = false;
    this.runTask = this.runLoop();
  }

  async stop() {
    this.stopped = true;
    if (this.socket) {
      this.socket.close();
    }
    if (this.runTask) {
      await this.runTask;
      this.runTask = null;
    }
  }

  async runLoop() {
    let delayMs = RECONNECT_MIN_MS;
    while (!this.stopped) {
      let session = null;
      try {
        session = await this.connectOnce();
        if (this.isStableSession(session)) {
          delayMs = RECONNECT_MIN_MS;
        }
      } catch (error) {
        this.api.logger.error(
          `[xiaozhi] bridge loop error ${accountLogLabel(this.accountId, this.accountConfig.bridgeId)}: ${normalizeError(error).message}`
        );
      }
      if (!this.stopped) {
        const nextDelayMs = this.getNextReconnectDelay(delayMs, session);
        await sleep(applyReconnectJitter(nextDelayMs));
        delayMs = nextDelayMs;
      }
    }
  }

  async connectOnce() {
    const url = buildBridgeUrl(
      this.accountConfig.serverUrl,
      this.accountConfig.bridgeToken
    );
    return await new Promise((resolve) => {
      let openedAt = 0;
      const socket = new WebSocket(url, {
        headers: this.accountConfig.bridgeToken
          ? { Authorization: `Bearer ${this.accountConfig.bridgeToken}` }
          : {}
      });
      this.socket = socket;

      socket.on("open", () => {
        openedAt = Date.now();
        this.api.logger.info(
          `[xiaozhi] bridge connected ${accountLogLabel(this.accountId, this.accountConfig.bridgeId)}`
        );
      });

      socket.on("message", async (data) => {
        try {
          const payload = JSON.parse(data.toString());
          await this.handlePayload(payload);
        } catch (error) {
          this.api.logger.error(
            `[xiaozhi] invalid payload ${accountLogLabel(this.accountId, this.accountConfig.bridgeId)}: ${normalizeError(error).message}`
          );
        }
      });

      socket.on("error", (error) => {
        this.api.logger.error(
          `[xiaozhi] websocket error ${accountLogLabel(this.accountId, this.accountConfig.bridgeId)}: ${normalizeError(error).message}`
        );
      });

      socket.on("close", (code, reason) => {
        const closedAt = Date.now();
        this.api.logger.warn(
          `[xiaozhi] bridge closed ${accountLogLabel(this.accountId, this.accountConfig.bridgeId)} code=${code} reason=${reason.toString()}`
        );
        const error = new Error(
          `xiaozhi bridge disconnected: ${accountLogLabel(this.accountId, this.accountConfig.bridgeId)}`
        );
        for (const pending of this.pendingResults.values()) {
          pending.reject(error);
        }
        this.pendingResults.clear();
        this.socket = null;
        resolve({
          code,
          reason: reason.toString(),
          openedAt,
          closedAt
        });
      });
    });
  }

  isStableSession(session) {
    if (!session || !session.openedAt || !session.closedAt) {
      return false;
    }
    return session.closedAt - session.openedAt >= RECONNECT_STABLE_MS;
  }

  getNextReconnectDelay(currentDelayMs, session) {
    if (this.isStableSession(session)) {
      return RECONNECT_MIN_MS;
    }
    return Math.min(
      Math.max(currentDelayMs * 2, RECONNECT_MIN_MS),
      RECONNECT_MAX_MS
    );
  }

  async handlePayload(payload) {
    if (!payload || typeof payload !== "object") {
      return;
    }
    if (payload.id !== undefined && ("result" in payload || "error" in payload)) {
      this.handleResult(payload);
      return;
    }
    const method = payload.method;
    const id = payload.id;
    if (!SUPPORTED_METHODS.has(method)) {
      if (id !== undefined) {
        this.send({
          jsonrpc: "2.0",
          id,
          error: {
            code: -32601,
            message: `Unsupported method: ${String(method)}`
          }
        });
      }
      return;
    }

    const params = {
      ...(payload.params ?? {}),
      account: payload?.params?.account || this.accountId
    };

    try {
      if (method === "xiaozhi.chat") {
        this.api.logger.info(
          `[xiaozhi] inbound chat account=${params.account} peer=${params.peerId || "unknown"} textLength=${String(params.text || "").length}`
        );
      } else if (method === "xiaozhi.bindPeerAgent") {
        this.api.logger.info(
          `[xiaozhi] bind peer account=${params.account} peer=${params.peerId || "unknown"} agent=${params.agentId || "unknown"}`
        );
      }

      let result = { ok: true };
      if (method === "xiaozhi.sessionStarted") {
        result = await this.router.onSessionStarted(params);
      } else if (method === "xiaozhi.sessionEnded") {
        result = await this.router.onSessionEnded(params);
      } else if (method === "xiaozhi.chat") {
        result = await this.router.routeChat(params);
      } else if (method === "xiaozhi.bindPeerAgent") {
        result = await this.router.bindPeerAgent(params);
      } else if (method === "xiaozhi.inventory") {
        result = await this.router.getInventory(params);
      } else if (method === "xiaozhi.clearPeerSession") {
        result = await this.router.clearPeerSession(params);
      } else if (method === "xiaozhi.debugSessionGet") {
        result = await this.router.getDebugSession(params);
      }

      if (id !== undefined) {
        this.send({
          jsonrpc: "2.0",
          id,
          result
        });
      }
    } catch (error) {
      this.api.logger.error(
        `[xiaozhi] rpc failed ${accountLogLabel(this.accountId, this.accountConfig.bridgeId)} method=${method}: ${normalizeError(error).message}`
      );
      if (id !== undefined) {
        this.send({
          jsonrpc: "2.0",
          id,
          error: normalizeError(error)
        });
      }
    }
  }

  send(payload) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }
    this.socket.send(JSON.stringify(payload));
  }

  async callServer(method, params, timeoutMs = REQUEST_TIMEOUT_MS) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("xiaozhi bridge is not connected");
    }

    const id = this.nextRequestId++;
    const pending = {};
    const promise = new Promise((resolve, reject) => {
      pending.resolve = resolve;
      pending.reject = reject;
      pending.timer = setTimeout(() => {
        this.pendingResults.delete(id);
        reject(new Error(`xiaozhi rpc timeout: ${method}`));
      }, timeoutMs);
    });

    this.pendingResults.set(id, pending);
    this.send({
      jsonrpc: "2.0",
      id,
      method,
      params: params ?? {}
    });
    return await promise;
  }

  handleResult(payload) {
    const pending = this.pendingResults.get(payload.id);
    if (!pending) {
      return;
    }
    this.pendingResults.delete(payload.id);
    clearTimeout(pending.timer);

    if (payload.error) {
      const message =
        typeof payload.error?.message === "string"
          ? payload.error.message
          : String(payload.error);
      pending.reject(new Error(message));
      return;
    }

    pending.resolve(payload.result);
  }
}
