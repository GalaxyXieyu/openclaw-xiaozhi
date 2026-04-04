import WebSocket from "ws";

import { XiaozhiAgentRouter } from "../router/agent-router.js";
import { RuntimeOverrideStore } from "../store/runtime-overrides.js";

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 15000;
const SUPPORTED_METHODS = new Set([
  "xiaozhi.sessionStarted",
  "xiaozhi.sessionEnded",
  "xiaozhi.chat",
  "xiaozhi.bindPeerAgent"
]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

class XiaozhiBridgeClient {
  constructor({ api, accountId, accountConfig, router }) {
    this.api = api;
    this.accountId = accountId;
    this.accountConfig = accountConfig;
    this.router = router;
    this.stopped = false;
    this.runTask = null;
    this.socket = null;
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
      try {
        await this.connectOnce();
        delayMs = RECONNECT_MIN_MS;
      } catch (error) {
        this.api.logger.error(
          `[xiaozhi] bridge loop error ${accountLogLabel(this.accountId, this.accountConfig.bridgeId)}: ${normalizeError(error).message}`
        );
      }
      if (!this.stopped) {
        await sleep(delayMs);
        delayMs = Math.min(delayMs * 2, RECONNECT_MAX_MS);
      }
    }
  }

  async connectOnce() {
    const url = buildBridgeUrl(
      this.accountConfig.serverUrl,
      this.accountConfig.bridgeToken
    );
    await new Promise((resolve) => {
      const socket = new WebSocket(url, {
        headers: this.accountConfig.bridgeToken
          ? { Authorization: `Bearer ${this.accountConfig.bridgeToken}` }
          : {}
      });
      this.socket = socket;

      socket.on("open", () => {
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
        this.api.logger.warn(
          `[xiaozhi] bridge closed ${accountLogLabel(this.accountId, this.accountConfig.bridgeId)} code=${code} reason=${reason.toString()}`
        );
        this.socket = null;
        resolve();
      });
    });
  }

  async handlePayload(payload) {
    if (!payload || typeof payload !== "object") {
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
      let result = { ok: true };
      if (method === "xiaozhi.sessionStarted") {
        result = await this.router.onSessionStarted(params);
      } else if (method === "xiaozhi.sessionEnded") {
        result = await this.router.onSessionEnded(params);
      } else if (method === "xiaozhi.chat") {
        result = await this.router.routeChat(params);
      } else if (method === "xiaozhi.bindPeerAgent") {
        result = await this.router.bindPeerAgent(params);
      }

      if (id !== undefined) {
        this.send({
          jsonrpc: "2.0",
          id,
          result
        });
      }
    } catch (error) {
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
}

export class XiaozhiBridgeService {
  constructor(api) {
    this.api = api;
    this.overrides = new RuntimeOverrideStore();
    this.router = new XiaozhiAgentRouter(api, this.overrides);
    this.clients = new Map();
  }

  async start() {
    const accounts = this.router.listAccounts();
    if (accounts.length === 0) {
      this.api.logger.info("[xiaozhi] no enabled accounts configured");
      return;
    }

    for (const [accountId, accountConfig] of accounts) {
      if (!accountConfig?.serverUrl || !accountConfig?.bridgeToken) {
        this.api.logger.warn(
          `[xiaozhi] skip account=${accountId}, serverUrl or bridgeToken missing`
        );
        continue;
      }
      const client = new XiaozhiBridgeClient({
        api: this.api,
        accountId,
        accountConfig,
        router: this.router
      });
      this.clients.set(accountId, client);
      await client.start();
    }
  }

  async stop() {
    const clients = [...this.clients.values()];
    this.clients.clear();
    for (const client of clients) {
      await client.stop();
    }
    this.overrides.clear();
  }
}
