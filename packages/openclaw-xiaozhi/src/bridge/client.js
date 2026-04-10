import { XiaozhiAgentRouter } from "../router/agent-router.js";
import { DebugTraceStore } from "../store/debug-trace-store.js";
import { PendingPushStore } from "../store/pending-push-store.js";
import { RuntimeOverrideStore } from "../store/runtime-overrides.js";
import { SessionTargetStore } from "../store/session-targets.js";
import { XiaozhiBridgeClient } from "./rpc-client.js";
import { XiaozhiSessionRuntime } from "./session-runtime.js";

const PENDING_PUSH_POLL_MS = 1500;

export class XiaozhiBridgeService {
  constructor(api) {
    this.api = api;
    this.overrides = new RuntimeOverrideStore();
    this.sessionTargets = new SessionTargetStore();
    this.debugTraceStore = new DebugTraceStore();
    this.pendingPushStore = new PendingPushStore();
    this.sessionRuntime = new XiaozhiSessionRuntime({
      api,
      sessionTargets: this.sessionTargets,
      debugTraceStore: this.debugTraceStore,
      pushText: (params, ctx) => this.pushText(params, ctx),
      syncAsyncWaiting: (params, ctx) => this.syncAsyncWaiting(params, ctx)
    });
    this.router = new XiaozhiAgentRouter(
      api,
      this.overrides,
      this.sessionTargets,
      this.debugTraceStore,
      {
        onRouteStart: (route) => {
          this.sessionRuntime.markRouteStart(route);
        },
        onRouteSettled: (route, text) => {
          this.sessionRuntime.markRouteSettled(route, text);
        }
      }
    );
    this.clients = new Map();
    this.pendingPushTimer = null;
    this.pendingPushRunning = false;
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
    this.startPendingPushWorker();
  }

  async stop() {
    if (this.pendingPushTimer) {
      clearInterval(this.pendingPushTimer);
      this.pendingPushTimer = null;
    }
    const clients = [...this.clients.values()];
    this.clients.clear();
    for (const client of clients) {
      await client.stop();
    }
    this.overrides.clear();
    this.sessionTargets.clear();
    this.sessionRuntime.clear();
    this.debugTraceStore.clear();
  }

  startPendingPushWorker() {
    if (this.pendingPushTimer) {
      return;
    }
    this.pendingPushTimer = setInterval(() => {
      this.drainPendingPushes().catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.api.logger.error(`[xiaozhi] pending push drain failed: ${message}`);
      });
    }, PENDING_PUSH_POLL_MS);
    this.drainPendingPushes().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.api.logger.error(`[xiaozhi] initial pending push drain failed: ${message}`);
    });
  }

  async drainPendingPushes() {
    if (this.pendingPushRunning) {
      return;
    }
    this.pendingPushRunning = true;
    try {
      const queuedEntries = this.pendingPushStore.list();
      for (const entry of queuedEntries) {
        try {
          await this.dispatchPushText(
            {
              account: entry.account,
              sessionId: entry.sessionId,
              deviceId: entry.deviceId,
              peerId: entry.peerId,
              text: entry.text
            },
            {
              sessionKey: entry.sessionKey,
              agentAccountId: entry.account,
              requesterSenderId: entry.peerId,
              debugSessionId: entry.debugSessionId
            },
            false
          );
          this.pendingPushStore.remove(entry.id);
          await this.syncAsyncWaiting(
            {
              account: entry.account,
              sessionId: entry.sessionId,
              deviceId: entry.deviceId,
              peerId: entry.peerId,
              enabled: false,
              source: "pending-push-delivered",
              reason: "async-reply-delivered"
            },
            {
              sessionKey: entry.sessionKey,
              agentAccountId: entry.account,
              requesterSenderId: entry.peerId,
              debugSessionId: entry.debugSessionId
            }
          );
          if (entry.debugSessionId) {
            this.debugTraceStore.recordDevicePushSucceeded(entry.debugSessionId, {
              sessionId: entry.sessionId,
              deviceId: entry.deviceId,
              peerId: entry.peerId,
              message: "结果已推送到当前设备。"
            });
            this.debugTraceStore.finishIfPending(entry.debugSessionId);
          }
          this.api.logger.info(
            `[xiaozhi] flushed queued push account=${entry.account} peer=${entry.peerId || ""} session=${entry.sessionId || ""}`
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.pendingPushStore.markAttempt(entry.id, message);
          this.api.logger.warn(
            `[xiaozhi] queued push retry failed account=${entry.account} peer=${entry.peerId || ""}: ${message}`
          );
        }
      }
    } finally {
      this.pendingPushRunning = false;
    }
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

    return await this.dispatchPushText(params, ctx, true);
  }

  async setAsyncWaiting(params, ctx = {}) {
    const enabled = Boolean(params?.enabled);
    const source =
      typeof params?.source === "string" ? params.source.trim() : "";
    const reason =
      typeof params?.reason === "string" ? params.reason.trim() : "";

    let target = null;
    try {
      target = this.resolvePushTarget(params, ctx);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.api.logger.warn(
        `[xiaozhi] skip async waiting sync enabled=${enabled ? "yes" : "no"} source=${source || "-"}: ${message}`
      );
      return {
        ok: false,
        skipped: true,
        reason: "missing-target",
        enabled
      };
    }

    const accountId = target.account || "default";
    const client = this.resolveClient(accountId);
    if (!client) {
      this.api.logger.warn(
        `[xiaozhi] skip async waiting sync enabled=${enabled ? "yes" : "no"} account=${accountId} source=${source || "-"}: bridge client unavailable`
      );
      return {
        ok: false,
        skipped: true,
        reason: "client-unavailable",
        enabled,
        ...target
      };
    }

    const method =
      client.accountConfig?.setAsyncWaitingMethod || "xiaozhi.setAsyncWaiting";
    this.api.logger.info(
      `[xiaozhi] sync async waiting account=${accountId} enabled=${enabled ? "yes" : "no"} session=${target.sessionId || ""} device=${target.deviceId || ""} peer=${target.peerId || ""} source=${source || "-"}`
    );
    const result = await client.callServer(method, {
      account: accountId,
      sessionId: target.sessionId,
      deviceId: target.deviceId,
      peerId: target.peerId,
      enabled,
      source,
      reason
    });
    return {
      ok: true,
      enabled,
      ...target,
      result
    };
  }

  async syncAsyncWaiting(params, ctx = {}) {
    const sessionKey =
      typeof ctx?.sessionKey === "string" ? ctx.sessionKey.trim() : "";
    const state = this.sessionRuntime.ensureReplyState(sessionKey);
    const enabled = Boolean(params?.enabled);
    if (state) {
      if (enabled && state.waitingSignalSent) {
        return {
          ok: true,
          skipped: true,
          reason: "already-synced",
          enabled
        };
      }
      if (!enabled && !state.waitingSignalSent) {
        return {
          ok: true,
          skipped: true,
          reason: "already-cleared",
          enabled
        };
      }
    }

    try {
      const result = await this.setAsyncWaiting(params, ctx);
      if (state && result?.ok && !result?.skipped) {
        state.waitingSignalSent = enabled;
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.api.logger.warn(
        `[xiaozhi] async waiting sync failed source=${params?.source || "-"}: ${message}`
      );
      return {
        ok: false,
        skipped: true,
        reason: "sync-failed",
        enabled,
        message
      };
    }
  }

  async dispatchPushText(params, ctx = {}, allowQueue = true) {
    const text = typeof params?.text === "string" ? params.text.trim() : "";
    if (!text) {
      throw new Error("text required");
    }
    const target = this.resolvePushTarget(params, ctx);
    const accountId = target.account || "default";
    const client = this.resolveClient(accountId);
    if (!client) {
      if (allowQueue) {
        const queued = this.pendingPushStore.enqueue({
          account: accountId,
          sessionId: target.sessionId,
          deviceId: target.deviceId,
          peerId: target.peerId,
          text,
          sessionKey: typeof ctx?.sessionKey === "string" ? ctx.sessionKey.trim() : "",
          debugSessionId: typeof ctx?.debugSessionId === "string" ? ctx.debugSessionId.trim() : ""
        });
        if (!queued) {
          throw new Error(`xiaozhi bridge client unavailable for account=${accountId}`);
        }
        this.api.logger.warn(
          `[xiaozhi] bridge client unavailable, queued push account=${accountId} peer=${target.peerId || ""} session=${target.sessionId || ""}`
        );
        return {
          ok: true,
          queued: true,
          queueId: queued.id,
          ...target
        };
      }
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
      queued: false,
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

  async sendOutboundText(params = {}) {
    return await this.sessionRuntime.sendOutboundText(params);
  }

  async sendOutboundMedia(params = {}) {
    return await this.sessionRuntime.sendOutboundMedia(params);
  }

  async handleAgentEnded(event, ctx = {}) {
    await this.sessionRuntime.handleAgentEnded(event, ctx);
  }

  handleSubagentSpawned(event, ctx = {}) {
    this.sessionRuntime.handleSubagentSpawned(event, ctx);
  }

  handleSessionEnded(ctx = {}) {
    this.sessionRuntime.handleSessionEnded(ctx);
  }
}
