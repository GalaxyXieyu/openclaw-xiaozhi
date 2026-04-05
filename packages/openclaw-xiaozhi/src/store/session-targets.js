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

  if (!sessionId && !deviceId && !peerId) {
    return null;
  }

  return {
    account: account || "default",
    sessionId: sessionId || undefined,
    deviceId: deviceId || undefined,
    peerId: peerId || undefined,
    clientId: clientId || undefined,
    speaker: speaker || undefined
  };
}

export class SessionTargetStore {
  constructor() {
    this.targets = new Map();
  }

  remember(sessionKey, target) {
    const key = typeof sessionKey === "string" ? sessionKey.trim() : "";
    const normalized = normalizeTarget(target);
    if (!key || !normalized) {
      return null;
    }
    this.targets.set(key, normalized);
    return normalized;
  }

  get(sessionKey) {
    const key = typeof sessionKey === "string" ? sessionKey.trim() : "";
    if (!key) {
      return null;
    }
    return this.targets.get(key) ?? null;
  }

  inherit(sourceSessionKey, targetSessionKey) {
    const source = this.get(sourceSessionKey);
    if (!source) {
      return null;
    }
    return this.remember(targetSessionKey, source);
  }

  delete(sessionKey) {
    const key = typeof sessionKey === "string" ? sessionKey.trim() : "";
    if (!key) {
      return;
    }
    this.targets.delete(key);
  }

  deleteByXiaozhiSession(account, sessionId) {
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
  }

  clear() {
    this.targets.clear();
  }
}
