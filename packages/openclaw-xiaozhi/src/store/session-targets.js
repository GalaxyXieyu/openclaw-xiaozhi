import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function normalizeTarget(target) {
  if (!target || typeof target !== "object") {
    return null;
  }

  const account = typeof target.account === "string" ? target.account.trim() : "";
  const sessionId =
    typeof target.sessionId === "string" ? target.sessionId.trim() : "";
  const deviceId =
    typeof target.deviceId === "string" ? target.deviceId.trim() : "";
  const peerId = typeof target.peerId === "string" ? target.peerId.trim() : "";
  const clientId =
    typeof target.clientId === "string" ? target.clientId.trim() : "";
  const speaker =
    typeof target.speaker === "string" ? target.speaker.trim() : "";
  const deliveryBinding = normalizeDeliveryBinding(target.deliveryBinding);

  if (!sessionId && !deviceId && !peerId) {
    return null;
  }

  return {
    account: account || "default",
    sessionId: sessionId || undefined,
    deviceId: deviceId || undefined,
    peerId: peerId || undefined,
    clientId: clientId || undefined,
    speaker: speaker || undefined,
    deliveryBinding: deliveryBinding || undefined
  };
}

function normalizeDeliveryBinding(binding) {
  if (!binding || typeof binding !== "object") {
    return null;
  }

  const enabled = Boolean(binding.enabled);
  const deliveryChannel =
    typeof binding.deliveryChannel === "string" ? binding.deliveryChannel.trim() : "";
  const accountId =
    typeof binding.accountId === "string" ? binding.accountId.trim() : "";
  const target =
    typeof binding.target === "string" ? binding.target.trim() : "";
  const threadId =
    typeof binding.threadId === "string" ? binding.threadId.trim() : "";
  const format =
    typeof binding.format === "string" && binding.format.trim()
      ? binding.format.trim()
      : "text";

  if (!enabled || !deliveryChannel || !target) {
    return null;
  }

  return {
    enabled: true,
    deliveryChannel,
    accountId: accountId || undefined,
    target,
    threadId: threadId || undefined,
    format
  };
}

function resolveStateFile() {
  const baseDir =
    (typeof process.env.OPENCLAW_STATE_DIR === "string" && process.env.OPENCLAW_STATE_DIR.trim()) ||
    path.join(os.homedir(), ".openclaw");
  const dir = path.join(baseDir, "cache", "xiaozhi");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "session-targets.json");
}

export class SessionTargetStore {
  constructor() {
    this.stateFile = resolveStateFile();
    this.targets = new Map();
    this.loadFromDisk();
  }

  loadFromDisk() {
    if (!fs.existsSync(this.stateFile)) {
      return;
    }
    try {
      const raw = fs.readFileSync(this.stateFile, "utf8");
      if (!raw.trim()) {
        return;
      }
      const parsed = JSON.parse(raw);
      this.targets = new Map(
        (Array.isArray(parsed?.targets) ? parsed.targets : [])
          .map((item) => {
            const key = typeof item?.sessionKey === "string" ? item.sessionKey.trim() : "";
            const target = normalizeTarget(item?.target);
            if (!key || !target) {
              return null;
            }
            return [key, target];
          })
          .filter(Boolean)
      );
    } catch {
      // ignore corrupted cache and keep in-memory state
    }
  }

  persistToDisk() {
    const payload = {
      targets: [...this.targets.entries()].map(([sessionKey, target]) => ({
        sessionKey,
        target
      }))
    };
    fs.writeFileSync(this.stateFile, JSON.stringify(payload), "utf8");
  }

  remember(sessionKey, target) {
    this.loadFromDisk();
    const key = typeof sessionKey === "string" ? sessionKey.trim() : "";
    const normalized = normalizeTarget(target);
    if (!key || !normalized) {
      return null;
    }
    this.targets.set(key, normalized);
    this.persistToDisk();
    return normalized;
  }

  get(sessionKey) {
    this.loadFromDisk();
    const key = typeof sessionKey === "string" ? sessionKey.trim() : "";
    if (!key) {
      return null;
    }
    return this.targets.get(key) ?? null;
  }

  inherit(sourceSessionKey, targetSessionKey) {
    this.loadFromDisk();
    const source = this.get(sourceSessionKey);
    if (!source) {
      return null;
    }
    return this.remember(targetSessionKey, source);
  }

  delete(sessionKey) {
    this.loadFromDisk();
    const key = typeof sessionKey === "string" ? sessionKey.trim() : "";
    if (!key) {
      return;
    }
    this.targets.delete(key);
    this.persistToDisk();
  }

  deleteByXiaozhiSession(account, sessionId) {
    this.loadFromDisk();
    const accountId =
      typeof account === "string" && account.trim() ? account.trim() : "default";
    const xiaozhiSessionId =
      typeof sessionId === "string" ? sessionId.trim() : "";
    if (!xiaozhiSessionId) {
      return;
    }

    for (const [sessionKey, target] of this.targets.entries()) {
      if (
        target?.account === accountId &&
        target?.sessionId === xiaozhiSessionId
      ) {
        this.targets.delete(sessionKey);
      }
    }
    this.persistToDisk();
  }

  clear() {
    this.targets.clear();
    this.persistToDisk();
  }
}
