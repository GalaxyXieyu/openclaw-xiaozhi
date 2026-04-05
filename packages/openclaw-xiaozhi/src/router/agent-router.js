import { resolveStaticBinding } from "../store/static-bindings.js";

const DEFAULT_AGENT_ID = "main";
const XIAOZHI_CHANNEL_ID = "xiaozhi";

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mergeObjects(base, extra) {
  if (!isObject(base)) {
    return isObject(extra) ? { ...extra } : extra;
  }
  if (!isObject(extra)) {
    return { ...base };
  }

  const result = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    if (isObject(value) && isObject(result[key])) {
      result[key] = mergeObjects(result[key], value);
      continue;
    }
    result[key] = value;
  }
  return result;
}

export class XiaozhiAgentRouter {
  constructor(api, overrides, sessionTargets) {
    this.api = api;
    this.overrides = overrides;
    this.sessionTargets = sessionTargets;
    this.sessions = new Map();
  }

  listAccounts() {
    const cfg = this.api.runtime.config.loadConfig();
    const section = cfg?.channels?.xiaozhi ?? {};
    const accounts = section?.accounts ?? {};
    return Object.entries(accounts).filter(([, account]) => account?.enabled !== false);
  }

  async onSessionStarted(params) {
    const key = this.buildSessionKey(params.account, params.sessionId);
    this.sessions.set(key, {
      account: params.account,
      sessionId: params.sessionId,
      peerId: params.peerId,
      deviceId: params.deviceId,
      clientId: params.clientId,
      speaker: params.speaker ?? null
    });
    return { ok: true };
  }

  async onSessionEnded(params) {
    const key = this.buildSessionKey(params.account, params.sessionId);
    this.sessions.delete(key);
    this.sessionTargets?.deleteByXiaozhiSession(params.account, params.sessionId);
    return { ok: true };
  }

  async bindPeerAgent(params) {
    const cfg = this.api.runtime.config.loadConfig();
    const accountId = params.account || "default";
    const peerId = params.peerId;
    const agentId = params.agentId;
    const agentInfo = this.resolveAgentConfig(cfg, agentId);
    const agentName =
      params.agentName || agentInfo.agentName || agentInfo.agentId || agentId;
    this.overrides.set(accountId, peerId, agentId);
    return {
      ok: true,
      account: accountId,
      peerId,
      agentId,
      agentName,
      confirmation: `好的，已切换到${agentName}`
    };
  }

  async routeChat(params) {
    const cfg = this.api.runtime.config.loadConfig();
    const accountId = params.account || "default";
    const accountConfig = this.resolveAccountConfig(cfg, accountId);
    const resolved = this.resolveTargetAgent(cfg, accountId, accountConfig, params.peerId);
    const text = await this.runAgent({
      cfg,
      agentId: resolved.agentId,
      agentName: resolved.agentName,
      accountId,
      peerId: params.peerId,
      prompt: params.text,
      speaker: params.speaker ?? null,
      sessionTarget: {
        account: accountId,
        sessionId: params.sessionId,
        deviceId: params.deviceId,
        clientId: params.clientId,
        peerId: params.peerId,
        speaker: params.speaker ?? null
      }
    });
    return {
      ok: true,
      text,
      agentId: resolved.agentId,
      agentName: resolved.agentName
    };
  }

  buildSessionKey(accountId, sessionId) {
    return `${accountId || "default"}::${sessionId || ""}`;
  }

  resolveAccountConfig(cfg, accountId) {
    const section = cfg?.channels?.xiaozhi ?? {};
    const accounts = section?.accounts ?? {};
    return accounts?.[accountId] ?? accounts?.[section?.defaultAccountId] ?? {};
  }

  resolveTargetAgent(cfg, accountId, accountConfig, peerId) {
    const runtimeOverride = this.overrides.get(accountId, peerId);
    const staticBinding = resolveStaticBinding(accountConfig, peerId);
    const defaultAgentId =
      accountConfig?.defaultAgentId ??
      cfg?.channels?.xiaozhi?.defaultAgentId ??
      this.resolveFallbackAgentId(cfg);
    const selectedAgentId = runtimeOverride || staticBinding || defaultAgentId;
    return this.resolveAgentConfig(cfg, selectedAgentId);
  }

  resolveFallbackAgentId(cfg) {
    const agents = Array.isArray(cfg?.agents?.list) ? cfg.agents.list : [];
    if (agents.length > 0 && typeof agents[0]?.id === "string") {
      return agents[0].id;
    }
    if (typeof cfg?.agent?.id === "string") {
      return cfg.agent.id;
    }
    return DEFAULT_AGENT_ID;
  }

  resolveAgentConfig(cfg, agentId) {
    const agents = Array.isArray(cfg?.agents?.list) ? cfg.agents.list : [];
    const defaults = isObject(cfg?.agents?.defaults) ? cfg.agents.defaults : {};
    const matched =
      agents.find((agent) => agent?.id === agentId || agent?.name === agentId) ??
      agents[0] ??
      null;

    if (!matched) {
      return {
        agentId: agentId || this.resolveFallbackAgentId(cfg),
        agentName: agentId || this.resolveFallbackAgentId(cfg),
        agentConfig: mergeObjects(defaults, cfg)
      };
    }

    const merged = mergeObjects(defaults, matched);
    return {
      agentId: matched.id || agentId || DEFAULT_AGENT_ID,
      agentName: matched.name || matched.label || matched.id || agentId || DEFAULT_AGENT_ID,
      agentConfig: merged
    };
  }

  buildRoutingConfig(cfg, { accountId, peerId, agentId }) {
    const bindings = Array.isArray(cfg?.bindings) ? cfg.bindings : [];
    return {
      ...cfg,
      bindings: [
        {
          type: "route",
          agentId,
          comment: "xiaozhi runtime override",
          match: {
            channel: XIAOZHI_CHANNEL_ID,
            accountId,
            peer: {
              kind: "direct",
              id: peerId
            }
          }
        },
        ...bindings
      ]
    };
  }

  buildInboundContext({
    route,
    accountId,
    peerId,
    prompt,
    speaker
  }) {
    const label = speaker || peerId;
    return this.api.runtime.channel.reply.finalizeInboundContext(
      {
        Body: prompt,
        BodyForAgent: prompt,
        RawBody: prompt,
        CommandBody: prompt,
        BodyForCommands: prompt,
        From: label,
        To: peerId,
        SessionKey: route.sessionKey,
        AccountId: accountId,
        SenderId: peerId,
        SenderName: speaker || undefined,
        Timestamp: Date.now(),
        Provider: XIAOZHI_CHANNEL_ID,
        Surface: XIAOZHI_CHANNEL_ID,
        ChatType: "direct",
        ConversationLabel: label,
        OriginatingChannel: XIAOZHI_CHANNEL_ID,
        OriginatingTo: peerId,
        ExplicitDeliverRoute: true
      },
      {
        forceBodyForAgent: true,
        forceBodyForCommands: true,
        forceChatType: true,
        forceConversationLabel: true
      }
    );
  }

  async runAgent({
    cfg,
    agentId,
    agentName,
    accountId,
    peerId,
    prompt,
    speaker,
    sessionTarget
  }) {
    const channelRuntime = this.api.runtime?.channel;
    if (
      !channelRuntime?.routing?.resolveAgentRoute ||
      !channelRuntime?.reply?.dispatchReplyWithBufferedBlockDispatcher ||
      !channelRuntime?.reply?.finalizeInboundContext ||
      !channelRuntime?.session?.resolveStorePath ||
      !channelRuntime?.session?.recordInboundSession
    ) {
      throw new Error("OpenClaw channel runtime is unavailable for xiaozhi routing");
    }

    const routingCfg = this.buildRoutingConfig(cfg, {
      accountId,
      peerId,
      agentId
    });
    const route = channelRuntime.routing.resolveAgentRoute({
      cfg: routingCfg,
      channel: XIAOZHI_CHANNEL_ID,
      accountId,
      peer: {
        kind: "direct",
        id: peerId
      }
    });
    this.rememberSessionTarget(route, sessionTarget);
    const ctx = this.buildInboundContext({
      route,
      accountId,
      peerId,
      prompt,
      speaker
    });
    const storePath = channelRuntime.session.resolveStorePath(undefined, {
      agentId: route.agentId
    });
    const lastRouteSessionKey =
      route.lastRoutePolicy === "main" ? route.mainSessionKey : route.sessionKey;

    this.api.logger.info(
      `[xiaozhi] route chat account=${accountId} peer=${peerId} agent=${route.agentId} session=${route.sessionKey} matchedBy=${route.matchedBy}`
    );

    await channelRuntime.session.recordInboundSession({
      storePath,
      sessionKey: route.sessionKey,
      ctx,
      createIfMissing: true,
      updateLastRoute: {
        sessionKey: lastRouteSessionKey,
        channel: XIAOZHI_CHANNEL_ID,
        to: peerId,
        accountId
      },
      onRecordError: (error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.api.logger.error(
          `[xiaozhi] record inbound session failed account=${accountId} peer=${peerId}: ${message}`
        );
      }
    });

    const finalTexts = [];
    const interimTexts = [];
    let dispatchError = null;

    await channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx,
      cfg: routingCfg,
      dispatcherOptions: {
        deliver: async (payload, info) => {
          const text = this.extractText(payload);
          if (!text) {
            return;
          }
          if (payload?.isError) {
            if (!dispatchError) {
              dispatchError = new Error(text);
            }
            return;
          }
          if (info?.kind === "final") {
            finalTexts.push(text);
            return;
          }
          interimTexts.push(text);
        },
        onError: (error, info) => {
          const message = error instanceof Error ? error.message : String(error);
          this.api.logger.error(
            `[xiaozhi] dispatch reply failed account=${accountId} peer=${peerId} agent=${agentId} kind=${info?.kind || "unknown"}: ${message}`
          );
          if (!dispatchError) {
            dispatchError = error instanceof Error ? error : new Error(message);
          }
        }
      }
    });

    const finalText = finalTexts.join("\n").trim();
    if (finalText) {
      return finalText;
    }

    const interimText = interimTexts.join("\n").trim();
    if (interimText) {
      return interimText;
    }

    if (dispatchError) {
      throw dispatchError;
    }

    this.api.logger.warn(
      `[xiaozhi] empty reply account=${accountId} peer=${peerId} agent=${agentName || agentId}`
    );
    return "";
  }

  rememberSessionTarget(route, params) {
    if (!this.sessionTargets || !route) {
      return;
    }

    const target = {
      account: params.account || "default",
      sessionId: params.sessionId,
      deviceId: params.deviceId,
      clientId: params.clientId,
      peerId: params.peerId,
      speaker: params.speaker ?? null
    };

    this.sessionTargets.remember(route.sessionKey, target);
    if (typeof route.mainSessionKey === "string" && route.mainSessionKey) {
      this.sessionTargets.remember(route.mainSessionKey, target);
    }
  }

  extractText(result) {
    if (!result) {
      return "";
    }
    if (typeof result === "string") {
      return result.trim();
    }
    if (Array.isArray(result)) {
      return result.map((item) => this.extractText(item)).filter(Boolean).join("\n");
    }
    if (!isObject(result)) {
      return String(result);
    }

    const directKeys = [
      "text",
      "reply",
      "response",
      "message",
      "finalText",
      "outputText"
    ];
    for (const key of directKeys) {
      if (typeof result[key] === "string" && result[key].trim()) {
        return result[key].trim();
      }
    }

    if (isObject(result.payload)) {
      const nested = this.extractText(result.payload);
      if (nested) {
        return nested;
      }
    }
    if (isObject(result.result)) {
      const nested = this.extractText(result.result);
      if (nested) {
        return nested;
      }
    }
    if (Array.isArray(result.messages)) {
      const nested = result.messages
        .map((item) => this.extractText(item))
        .filter(Boolean)
        .join("\n");
      if (nested) {
        return nested;
      }
    }

    return JSON.stringify(result);
  }
}
