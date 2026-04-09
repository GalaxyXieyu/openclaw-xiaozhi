import WebSocket from "ws";

import { XiaozhiAgentRouter } from "../router/agent-router.js";
import { DebugTraceStore } from "../store/debug-trace-store.js";
import { RuntimeOverrideStore } from "../store/runtime-overrides.js";
import { SessionTargetStore } from "../store/session-targets.js";

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 15000;
const RECONNECT_STABLE_MS = 60000;
const RECONNECT_JITTER_RATIO = 0.2;
const REQUEST_TIMEOUT_MS = 30000;
const XIAOZHI_CHANNEL_ID = "xiaozhi";
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

class XiaozhiBridgeClient {
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

export class XiaozhiBridgeService {
  constructor(api) {
    this.api = api;
    this.overrides = new RuntimeOverrideStore();
    this.sessionTargets = new SessionTargetStore();
    this.debugTraceStore = new DebugTraceStore();
    this.replyState = new Map();
    this.router = new XiaozhiAgentRouter(api, this.overrides, this.sessionTargets, this.debugTraceStore, {
      onRouteStart: (route) => {
        this.markRouteStart(route);
      },
      onRouteSettled: (route, text) => {
        this.markRouteSettled(route, text);
      }
    });
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
    this.sessionTargets.clear();
    this.replyState.clear();
    this.debugTraceStore.clear();
  }

  createPushTextTool(ctx) {
    return {
      name: "xiaozhi_push_text",
      label: "Xiaozhi Push Text",
      description:
        "Push a spoken message to the current Xiaozhi device. Use this when a background task or subagent finishes and the hardware should proactively speak the result.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          text: {
            type: "string",
            description: "The text that Xiaozhi should speak."
          },
          sessionId: {
            type: "string",
            description: "Optional xiaozhi-server sessionId override."
          },
          deviceId: {
            type: "string",
            description: "Optional device-id override."
          },
          peerId: {
            type: "string",
            description: "Optional peer.id override, such as device-id or device-id:user-id."
          },
          account: {
            type: "string",
            description: "Optional Xiaozhi account override. Defaults to the current account."
          }
        },
        required: ["text"]
      },
      execute: async (_id, params) => this.pushText(params, ctx)
    };
  }

  async pushText(params, ctx = {}) {
    const text = typeof params?.text === "string" ? params.text.trim() : "";
    if (!text) {
      throw new Error("text required");
    }

    const target = this.resolvePushTarget(params, ctx);
    const accountId = target.account || "default";
    const client = this.resolveClient(accountId);
    if (!client) {
      throw new Error(`xiaozhi bridge client unavailable for account=${accountId}`);
    }

    const method =
      client.accountConfig?.pushTextMethod || "xiaozhi.pushText";
    this.api.logger.info(
      `[xiaozhi] push text account=${accountId} session=${target.sessionId || ""} device=${target.deviceId || ""} peer=${target.peerId || ""} sourceSession=${ctx?.sessionKey || ""}`
    );
    const result = await client.callServer(method, {
      account: accountId,
      sessionId: target.sessionId,
      deviceId: target.deviceId,
      peerId: target.peerId,
      text
    });
    return {
      ok: true,
      ...target,
      result
    };
  }

  resolvePushTarget(params, ctx = {}) {
    const explicitAccount =
      typeof params?.account === "string" && params.account.trim()
        ? params.account.trim()
        : "";
    const explicitSessionId =
      typeof params?.sessionId === "string" && params.sessionId.trim()
        ? params.sessionId.trim()
        : "";
    const explicitDeviceId =
      typeof params?.deviceId === "string" && params.deviceId.trim()
        ? params.deviceId.trim()
        : "";
    const explicitPeerId =
      typeof params?.peerId === "string" && params.peerId.trim()
        ? params.peerId.trim()
        : "";

    if (explicitSessionId || explicitDeviceId || explicitPeerId) {
      return {
        account: explicitAccount || ctx?.agentAccountId || "default",
        sessionId: explicitSessionId || undefined,
        deviceId: explicitDeviceId || undefined,
        peerId: explicitPeerId || undefined
      };
    }

    const mappedTarget = this.sessionTargets.get(ctx?.sessionKey);
    if (mappedTarget) {
      return {
        ...mappedTarget,
        account: explicitAccount || mappedTarget.account || ctx?.agentAccountId || "default"
      };
    }

    if (typeof ctx?.requesterSenderId === "string" && ctx.requesterSenderId.trim()) {
      return {
        account: explicitAccount || ctx?.agentAccountId || "default",
        peerId: ctx.requesterSenderId.trim()
      };
    }

    throw new Error(
      "No Xiaozhi target available. Provide sessionId/deviceId/peerId or call this tool from a Xiaozhi-routed session."
    );
  }

  resolveClient(accountId) {
    const exact = this.clients.get(accountId);
    if (exact) {
      return exact;
    }
    if (this.clients.size === 1) {
      return [...this.clients.values()][0];
    }
    return this.clients.get("default") ?? null;
  }

  getRouteKeys(routeOrSessionKey) {
    if (typeof routeOrSessionKey === "string") {
      return routeOrSessionKey.trim() ? [routeOrSessionKey.trim()] : [];
    }

    const keys = new Set();
    const sessionKey =
      typeof routeOrSessionKey?.sessionKey === "string"
        ? routeOrSessionKey.sessionKey.trim()
        : "";
    const mainSessionKey =
      typeof routeOrSessionKey?.mainSessionKey === "string"
        ? routeOrSessionKey.mainSessionKey.trim()
        : "";
    if (sessionKey) {
      keys.add(sessionKey);
    }
    if (mainSessionKey) {
      keys.add(mainSessionKey);
    }
    return [...keys];
  }

  ensureReplyState(sessionKey) {
    const key = typeof sessionKey === "string" ? sessionKey.trim() : "";
    if (!key) {
      return null;
    }
    const current =
      this.replyState.get(key) ??
      {
        isRouteRoot: false,
        activeSyncRuns: 0,
        lastImmediateText: "",
        lastPushedText: ""
      };
    this.replyState.set(key, current);
    return current;
  }

  markRouteStart(route) {
    for (const sessionKey of this.getRouteKeys(route)) {
      const state = this.ensureReplyState(sessionKey);
      if (!state) {
        continue;
      }
      state.isRouteRoot = true;
      state.activeSyncRuns += 1;
    }
  }

  markRouteSettled(route, text = "") {
    const normalizedText = this.normalizePushText(text);
    for (const sessionKey of this.getRouteKeys(route)) {
      const state = this.ensureReplyState(sessionKey);
      if (!state) {
        continue;
      }
      state.activeSyncRuns = Math.max(0, state.activeSyncRuns - 1);
      if (normalizedText) {
        state.lastImmediateText = normalizedText;
      }
    }
  }

  async handleAgentEnded(event, ctx = {}) {
    const sessionKey =
      typeof ctx?.sessionKey === "string" ? ctx.sessionKey.trim() : "";
    if (!sessionKey) {
      return;
    }

    const channelId =
      typeof ctx?.channelId === "string" ? ctx.channelId.trim() : "";
    const messageProvider =
      typeof ctx?.messageProvider === "string" ? ctx.messageProvider.trim() : "";
    if (
      channelId !== XIAOZHI_CHANNEL_ID &&
      messageProvider !== XIAOZHI_CHANNEL_ID
    ) {
      return;
    }

    const target = this.sessionTargets.get(sessionKey);
    const debugSessionId = this.debugTraceStore.getDebugSessionIdForSession(sessionKey);
    const state = this.replyState.get(sessionKey) ?? null;
    if (!state?.isRouteRoot) {
      if (debugSessionId) {
        const finalText = this.normalizePushText(
          this.extractFinalAssistantText(event?.messages)
        );
        this.debugTraceStore.recordSubagentCompleted(debugSessionId, {
          sessionKey,
          agentId: this.resolveAgentId(event, ctx),
          agentName: this.resolveAgentName(event, ctx),
          summary: finalText || "子任务执行完成"
        });
      }
      return;
    }

    if (state?.activeSyncRuns > 0 && !debugSessionId) {
      this.api.logger.info(
        `[xiaozhi] skip auto-push for active sync run session=${sessionKey}`
      );
      return;
    }

    const finalText = this.normalizePushText(
      this.extractFinalAssistantText(event?.messages)
    );
    if (!finalText || finalText === "NO_REPLY") {
      if (debugSessionId) {
        this.debugTraceStore.finishIfPending(debugSessionId);
      }
      return;
    }

    if (debugSessionId) {
      this.debugTraceStore.recordReplyReady(debugSessionId, finalText);
      if (this.debugTraceStore.shouldPrepareBrowserAudio(debugSessionId)) {
        this.debugTraceStore.recordBrowserAudioReady(debugSessionId, finalText);
      }
    }

    if (
      finalText === state?.lastImmediateText ||
      finalText === state?.lastPushedText
    ) {
      if (debugSessionId) {
        this.debugTraceStore.finishIfPending(debugSessionId);
      }
      this.api.logger.info(
        `[xiaozhi] skip duplicate auto-push session=${sessionKey}`
      );
      return;
    }

    if (!target) {
      if (debugSessionId) {
        this.debugTraceStore.finishIfPending(debugSessionId);
      }
      return;
    }

    const shouldPushToDevice =
      !debugSessionId || this.debugTraceStore.shouldPushToDevice(debugSessionId);
    if (!shouldPushToDevice) {
      this.debugTraceStore.finishIfPending(debugSessionId);
      return;
    }

    if (debugSessionId) {
      this.debugTraceStore.recordDevicePushStarted(debugSessionId);
    }
    try {
      await this.pushText(
        {
          account: target.account,
          sessionId: target.sessionId,
          deviceId: target.deviceId,
          peerId: target.peerId,
          text: finalText
        },
        {
          sessionKey,
          agentAccountId: target.account,
          requesterSenderId: target.peerId
        }
      );
      if (state) {
        state.lastPushedText = finalText;
      }
      if (debugSessionId) {
        this.debugTraceStore.recordDevicePushSucceeded(debugSessionId, {
          sessionId: target.sessionId,
          deviceId: target.deviceId,
          peerId: target.peerId,
          message: "结果已推送到当前设备。"
        });
        this.debugTraceStore.finishIfPending(debugSessionId);
      }
      this.api.logger.info(
        `[xiaozhi] auto-pushed async reply session=${sessionKey} peer=${target.peerId || ""}`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (debugSessionId) {
        this.debugTraceStore.recordDevicePushFailed(debugSessionId, message);
        this.debugTraceStore.finishIfPending(debugSessionId);
      }
      this.api.logger.error(
        `[xiaozhi] auto-push failed session=${sessionKey}: ${message}`
      );
    }
  }

  extractFinalAssistantText(messages) {
    if (!Array.isArray(messages)) {
      return "";
    }

    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const candidate = this.extractAssistantMessageText(messages[index]);
      if (candidate) {
        return candidate;
      }
    }
    return "";
  }

  extractAssistantMessageText(entry) {
    const message =
      entry && typeof entry === "object" && entry.message && typeof entry.message === "object"
        ? entry.message
        : entry;
    if (!message || typeof message !== "object") {
      return "";
    }
    if (message.role !== "assistant") {
      return "";
    }
    return this.extractRichText(message.content ?? message.text ?? message);
  }

  extractRichText(value) {
    if (!value) {
      return "";
    }
    if (typeof value === "string") {
      return value.trim();
    }
    if (Array.isArray(value)) {
      return value
        .map((item) => this.extractRichText(item))
        .filter(Boolean)
        .join("\n")
        .trim();
    }
    if (typeof value !== "object") {
      return String(value).trim();
    }

    if (value.type === "text" && typeof value.text === "string") {
      return value.text.trim();
    }

    const directKeys = ["text", "content", "message", "payload", "result"];
    for (const key of directKeys) {
      const candidate = this.extractRichText(value[key]);
      if (candidate) {
        return candidate;
      }
    }

    return "";
  }

  normalizePushText(text) {
    const input = typeof text === "string" ? text : "";
    return input
      .replace(/\[\[reply_to_current\]\]\s*/g, "")
      .replace(/^MEDIA:\s+.*$/gmu, "")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, "$1")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/^#{1,6}\s+/gmu, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  handleSubagentSpawned(event, ctx = {}) {
    const sourceSessionKey = ctx?.requesterSessionKey || event?.requesterSessionKey;
    const childSessionKey = ctx?.childSessionKey || event?.childSessionKey;
    const inherited = this.sessionTargets.inherit(sourceSessionKey, childSessionKey);
    const debugSessionId = this.debugTraceStore.inherit(sourceSessionKey, childSessionKey);
    if (!inherited) {
      return;
    }
    if (debugSessionId) {
      this.debugTraceStore.recordSubagentSpawned(debugSessionId, {
        sessionKey: childSessionKey,
        agentId: this.resolveChildAgentId(event, ctx),
        agentName: this.resolveChildAgentName(event, ctx),
        message:
          this.resolveChildAgentName(event, ctx) ||
          this.resolveChildAgentId(event, ctx) ||
          childSessionKey ||
          "后台任务已启动"
      });
    }
    this.api.logger.info(
      `[xiaozhi] inherited target requester=${sourceSessionKey || ""} child=${childSessionKey || ""} device=${inherited.deviceId || ""} peer=${inherited.peerId || ""}`
    );
  }

  handleSessionEnded(ctx = {}) {
    if (!ctx?.sessionKey) {
      return;
    }
    this.sessionTargets.delete(ctx.sessionKey);
    this.replyState.delete(ctx.sessionKey);
    this.debugTraceStore.clearSessionKeys(ctx.sessionKey);
  }

  resolveAgentId(event, ctx = {}) {
    const candidates = [
      ctx?.agentId,
      ctx?.resolvedAgentId,
      event?.agentId,
      event?.resolvedAgentId
    ];
    return candidates.find((value) => typeof value === "string" && value.trim()) || "";
  }

  resolveAgentName(event, ctx = {}) {
    const candidates = [
      ctx?.agentName,
      ctx?.resolvedAgentName,
      event?.agentName,
      event?.resolvedAgentName
    ];
    return candidates.find((value) => typeof value === "string" && value.trim()) || "";
  }

  resolveChildAgentId(event, ctx = {}) {
    const candidates = [
      ctx?.childAgentId,
      event?.childAgentId,
      ctx?.agentId,
      event?.agentId
    ];
    return candidates.find((value) => typeof value === "string" && value.trim()) || "";
  }

  resolveChildAgentName(event, ctx = {}) {
    const candidates = [
      ctx?.childAgentName,
      event?.childAgentName,
      ctx?.agentName,
      event?.agentName
    ];
    return candidates.find((value) => typeof value === "string" && value.trim()) || "";
  }
}
