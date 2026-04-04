import crypto from "node:crypto";

import { resolveStaticBinding } from "../store/static-bindings.js";

const DEFAULT_AGENT_ID = "main";

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

export class XiaozhiAgentRouter {
  constructor(api, overrides) {
    this.api = api;
    this.overrides = overrides;
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
      agentConfig: resolved.agentConfig,
      agentId: resolved.agentId,
      accountId,
      peerId: params.peerId,
      prompt: params.text
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

  async runAgent({ agentConfig, agentId, accountId, peerId, prompt }) {
    const sessionId = sanitizeSessionId(
      `xiaozhi-${accountId || "default"}-${agentId || DEFAULT_AGENT_ID}-${peerId || "peer"}`
    );
    await this.api.runtime.agent.ensureAgentWorkspace(agentConfig);
    const sessionFile = this.api.runtime.agent.session.resolveSessionFilePath(
      agentConfig,
      sessionId
    );
    const workspaceDir = this.api.runtime.agent.resolveAgentWorkspaceDir(agentConfig);
    const timeoutMs = this.api.runtime.agent.resolveAgentTimeoutMs(agentConfig);
    const result = await this.api.runtime.agent.runEmbeddedPiAgent({
      sessionId,
      runId: crypto.randomUUID(),
      config: agentConfig,
      sessionFile,
      workspaceDir,
      prompt,
      timeoutMs
    });
    return this.extractText(result);
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
