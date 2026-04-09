import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resolveStaticBinding } from "../store/static-bindings.js";

const DEFAULT_AGENT_ID = "main";
const XIAOZHI_CHANNEL_ID = "xiaozhi";
let coreRootCache = null;
let coreDepsPromise = null;

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

function sanitizeSessionId(value) {
  return String(value || "")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 180);
}

function normalizeBindingEntries(bindings) {
  if (Array.isArray(bindings)) {
    return bindings
      .map((item) => {
        if (!isObject(item)) {
          return null;
        }
        const peerId = typeof item.peerId === "string" ? item.peerId.trim() : "";
        const agentId = typeof item.agentId === "string" ? item.agentId.trim() : "";
        if (!peerId || !agentId) {
          return null;
        }
        return { peerId, agentId };
      })
      .filter(Boolean);
  }

  if (!isObject(bindings)) {
    return [];
  }

  return Object.entries(bindings)
    .map(([peerId, agentId]) => {
      const finalPeerId = typeof peerId === "string" ? peerId.trim() : "";
      const finalAgentId = typeof agentId === "string" ? agentId.trim() : "";
      if (!finalPeerId || !finalAgentId) {
        return null;
      }
      return {
        peerId: finalPeerId,
        agentId: finalAgentId
      };
    })
    .filter(Boolean);
}

function resolvePrimaryModelRef(config) {
  const primary = typeof config?.model?.primary === "string" ? config.model.primary.trim() : "";
  if (primary) {
    return primary;
  }

  if (isObject(config?.models)) {
    const first = Object.keys(config.models).find(Boolean);
    if (first) {
      return first;
    }
  }

  return "";
}

function splitModelRef(modelRef) {
  const normalized = String(modelRef || "").trim();
  const slashIndex = normalized.indexOf("/");
  if (!normalized || slashIndex <= 0 || slashIndex === normalized.length - 1) {
    return { provider: undefined, model: undefined };
  }
  return {
    provider: normalized.slice(0, slashIndex),
    model: normalized.slice(slashIndex + 1)
  };
}

function findPackageRoot(startDir, name) {
  let dir = startDir;
  for (;;) {
    const pkgPath = path.join(dir, "package.json");
    try {
      if (fs.existsSync(pkgPath)) {
        const raw = fs.readFileSync(pkgPath, "utf8");
        const pkg = JSON.parse(raw);
        if (pkg?.name === name) {
          return dir;
        }
      }
    } catch {
      // ignore parse errors and keep walking
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

function resolveOpenClawRoot() {
  if (coreRootCache) {
    return coreRootCache;
  }

  const override = process.env.OPENCLAW_ROOT?.trim();
  if (override) {
    coreRootCache = override;
    return override;
  }

  const candidates = new Set();
  if (process.argv[1]) {
    candidates.add(path.dirname(process.argv[1]));
  }
  candidates.add(process.cwd());
  try {
    candidates.add(path.dirname(fileURLToPath(import.meta.url)));
  } catch {
    // ignore
  }

  for (const start of candidates) {
    const found = findPackageRoot(start, "openclaw");
    if (found) {
      coreRootCache = found;
      return found;
    }
  }

  throw new Error("Unable to resolve OpenClaw root. Set OPENCLAW_ROOT to the package root.");
}

async function loadCoreAgentDeps() {
  if (coreDepsPromise) {
    return coreDepsPromise;
  }

  coreDepsPromise = (async () => {
    const distPath = path.join(resolveOpenClawRoot(), "dist", "extensionAPI.js");
    if (!fs.existsSync(distPath)) {
      throw new Error(
        `Missing core module at ${distPath}. Run \`pnpm build\` or install the official package.`
      );
    }
    return await import(pathToFileURL(distPath).href);
  })();

  return coreDepsPromise;
}
export class XiaozhiAgentRouter {
  constructor(api, overrides, sessionTargets, debugTraceStore, hooks = {}) {
    this.api = api;
    this.overrides = overrides;
    this.sessionTargets = sessionTargets;
    this.debugTraceStore = debugTraceStore;
    this.hooks = hooks;
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

  async getInventory(params) {
    const cfg = this.api.runtime.config.loadConfig();
    const accountId = params.account || "default";
    const accountConfig = this.resolveAccountConfig(cfg, accountId);
    const agents = this.listAgentOptions(cfg);
    const defaultAgentId =
      accountConfig?.defaultAgentId ??
      cfg?.channels?.xiaozhi?.defaultAgentId ??
      this.resolveFallbackAgentId(cfg);

    return {
      ok: true,
      accountId,
      runtimeAccount: {
        value: accountId,
        label: accountConfig?.name || accountConfig?.bridgeId || accountId
      },
      bridgeId: accountConfig?.bridgeId || null,
      defaultAgentId,
      agents,
      staticBindings: normalizeBindingEntries(
        accountConfig?.staticBindings ?? accountConfig?.bindings
      )
    };
  }

  async clearPeerSession(params) {
    const accountId = params.account || "default";
    const peerId =
      params.peerId || params.deviceId || params.clientId || null;
    const sessionId = params.sessionId || null;

    if (peerId) {
      this.overrides.delete(accountId, peerId);
    }
    if (sessionId) {
      const key = this.buildSessionKey(accountId, sessionId);
      this.sessions.delete(key);
      this.sessionTargets?.deleteByXiaozhiSession(accountId, sessionId);
    }

    return {
      ok: true,
      account: accountId,
      peerId,
      sessionId,
      cleared: {
        runtimeOverride: Boolean(peerId),
        session: Boolean(sessionId)
      }
    };
  }

  async routeChat(params) {
    const cfg = this.api.runtime.config.loadConfig();
    const accountId = params.account || "default";
    const accountConfig = this.resolveAccountConfig(cfg, accountId);
    const resolved = this.resolveTargetAgent(cfg, accountId, accountConfig, params.peerId);
    if (Boolean(params?.deferReply) && params?.debugSessionId) {
      return this.startDeferredDebugChat({
        cfg,
        resolved,
        accountId,
        params
      });
    }
    const text = await this.runAgent({
      cfg,
      agentConfig: resolved.agentConfig,
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

  async getDebugSession(params) {
    const debugSessionId =
      typeof params?.debugSessionId === "string" ? params.debugSessionId.trim() : "";
    if (!debugSessionId) {
      throw new Error("debugSessionId required");
    }
    const snapshot = this.debugTraceStore?.getSnapshot(
      debugSessionId,
      Number(params?.sinceSeq || 0)
    );
    if (!snapshot) {
      throw new Error(`debug session not found: ${debugSessionId}`);
    }
    return snapshot;
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

  listAgentOptions(cfg) {
    const agents = Array.isArray(cfg?.agents?.list) ? cfg.agents.list : [];
    if (agents.length === 0) {
      const fallbackAgentId = this.resolveFallbackAgentId(cfg);
      return fallbackAgentId
        ? [{ value: fallbackAgentId, label: fallbackAgentId }]
        : [];
    }

    return agents
      .map((agent) => {
        const value =
          typeof agent?.id === "string" && agent.id.trim()
            ? agent.id.trim()
            : typeof agent?.name === "string" && agent.name.trim()
              ? agent.name.trim()
              : "";
        if (!value) {
          return null;
        }
        return {
          value,
          label:
            (typeof agent?.name === "string" && agent.name.trim()) ||
            (typeof agent?.label === "string" && agent.label.trim()) ||
            value
        };
      })
      .filter(Boolean);
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
    agentConfig,
    agentId,
    agentName,
    accountId,
    peerId,
    prompt,
    speaker,
    sessionTarget,
    debugSessionId = "",
    pushToDevice = false,
    browserAudio = false
  }) {
    const sessionId = sanitizeSessionId(
      `xiaozhi-${accountId || "default"}-${agentId || DEFAULT_AGENT_ID}-${peerId || "peer"}`
    );
    const channelRuntime = this.api.runtime?.channel;
    const canUseChannelRuntime =
      channelRuntime?.routing?.resolveAgentRoute &&
      channelRuntime?.reply?.dispatchReplyWithBufferedBlockDispatcher &&
      channelRuntime?.reply?.finalizeInboundContext &&
      channelRuntime?.session?.resolveStorePath &&
      channelRuntime?.session?.recordInboundSession;

    if (!canUseChannelRuntime) {
      return await this.runEmbeddedAgentFallback({
        cfg,
        agentConfig,
        agentId,
        accountId,
        peerId,
        prompt,
        sessionId
      });
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
    this.hooks?.onRouteStart?.(route);
    this.rememberSessionTarget(route, sessionTarget);
    if (debugSessionId && this.debugTraceStore) {
      this.debugTraceStore.attachRoute(debugSessionId, route, {
        account: accountId,
        peerId,
        agentId: route.agentId || agentId,
        agentName: agentName || route.agentId,
        pushToDevice,
        browserAudio
      });
      this.api.logger.info(
        `[xiaozhi][debug] attach_route debug=${debugSessionId} session=${route.sessionKey || ""} main=${route.mainSessionKey || ""}`
      );
    }
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
    let routeSettled = false;
    const settleRoute = (text = "") => {
      if (routeSettled) {
        return;
      }
      routeSettled = true;
      this.hooks?.onRouteSettled?.(route, text);
    };

    try {
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
    } catch (error) {
      settleRoute();
      throw error;
    }

    const finalText = finalTexts.join("\n").trim();
    if (finalText) {
      settleRoute(finalText);
      return finalText;
    }

    const interimText = interimTexts.join("\n").trim();
    if (interimText) {
      settleRoute(interimText);
      return interimText;
    }

    if (dispatchError) {
      settleRoute();
      throw dispatchError;
    }

    this.api.logger.warn(
      `[xiaozhi] empty reply account=${accountId} peer=${peerId} agent=${agentName || agentId}`
    );
    settleRoute();
    return "";
  }

  async runEmbeddedAgentFallback({
    cfg,
    agentConfig,
    agentId,
    accountId,
    peerId,
    prompt,
    sessionId
  }) {
    const runtimeAgent = this.api?.runtime?.agent;
    const effectiveConfig = agentConfig ?? cfg;
    const modelRef = resolvePrimaryModelRef(effectiveConfig);
    const { provider, model } = splitModelRef(modelRef);

    let result;
    if (runtimeAgent?.ensureAgentWorkspace && runtimeAgent?.runEmbeddedPiAgent) {
      await runtimeAgent.ensureAgentWorkspace(effectiveConfig);
      const sessionFile = runtimeAgent.session.resolveSessionFilePath(effectiveConfig, sessionId);
      const workspaceDir = runtimeAgent.resolveAgentWorkspaceDir(effectiveConfig);
      const timeoutMs = runtimeAgent.resolveAgentTimeoutMs(effectiveConfig);
      result = await runtimeAgent.runEmbeddedPiAgent({
        sessionId,
        runId: crypto.randomUUID(),
        config: effectiveConfig,
        sessionFile,
        workspaceDir,
        prompt,
        timeoutMs,
        provider,
        model
      });
    } else {
      const deps = await loadCoreAgentDeps();
      const workspaceDir = deps.resolveAgentWorkspaceDir(cfg, agentId || DEFAULT_AGENT_ID);
      const sessionFile = deps.resolveSessionFilePath(sessionId, undefined, {
        agentId: agentId || DEFAULT_AGENT_ID
      });
      const agentDir = deps.resolveAgentDir(cfg, agentId || DEFAULT_AGENT_ID);
      const timeoutMs = deps.resolveAgentTimeoutMs({ cfg });
      const thinkLevel =
        provider && model ? deps.resolveThinkingDefault({ cfg, provider, model }) : undefined;
      await deps.ensureAgentWorkspace({ dir: workspaceDir });
      result = await deps.runEmbeddedPiAgent({
        sessionId,
        sessionKey: `xiaozhi:${accountId || "default"}:${peerId || "peer"}`,
        messageProvider: "xiaozhi",
        runId: crypto.randomUUID(),
        config: cfg,
        sessionFile,
        workspaceDir,
        prompt,
        timeoutMs,
        agentDir,
        lane: "default",
        verboseLevel: "off",
        provider,
        model,
        thinkLevel
      });
    }

    return this.extractText(result);
  }

  rememberSessionTarget(route, params) {
    if (!this.sessionTargets || !route || !params) {
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

  startDeferredDebugChat({ cfg, resolved, accountId, params }) {
    const debugSessionId = String(params.debugSessionId || "").trim();
    const peerId = params.peerId;
    const browserAudio = Boolean(params.browserAudio);
    const pushToDevice = Boolean(params.pushToDevice);

    this.debugTraceStore?.accept({
      debugSessionId,
      account: accountId,
      bridgeId: params.bridgeId,
      peerId,
      agentId: resolved.agentId,
      agentName: resolved.agentName,
      pushToDevice,
      browserAudio
    });

    Promise.resolve()
      .then(async () => {
        await this.runAgent({
          cfg,
          agentConfig: resolved.agentConfig,
          agentId: resolved.agentId,
          agentName: resolved.agentName,
          accountId,
          peerId,
          prompt: params.text,
          speaker: params.speaker ?? null,
          sessionTarget: {
            account: accountId,
            sessionId: params.sessionId,
            deviceId: params.deviceId,
            clientId: params.clientId,
            peerId: params.targetPeerId || undefined,
            speaker: params.speaker ?? null
          },
          debugSessionId,
          pushToDevice,
          browserAudio
        });
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.api.logger.error(
          `[xiaozhi] deferred debug failed account=${accountId} peer=${peerId || "unknown"} session=${debugSessionId}: ${message}`
        );
        this.debugTraceStore?.markFailed(debugSessionId, message);
      });

    return {
      ok: true,
      accepted: true,
      status: "accepted",
      debugSessionId,
      account: accountId,
      peerId,
      agentId: resolved.agentId,
      agentName: resolved.agentName,
      pushToDevice,
      browserAudio
    };
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
    if (Array.isArray(result.payloads)) {
      const nested = result.payloads
        .filter((item) => !item?.isError)
        .map((item) => this.extractText(item))
        .filter(Boolean)
        .join("\n");
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
