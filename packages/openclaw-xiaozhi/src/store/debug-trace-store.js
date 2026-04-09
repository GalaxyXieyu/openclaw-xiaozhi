function cloneValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => cloneValue(item));
  }
  if (value && typeof value === "object") {
    const output = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = cloneValue(item);
    }
    return output;
  }
  return value;
}

function normalizeDebugSessionId(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeSessionKey(value) {
  return typeof value === "string" ? value.trim() : "";
}

function createEvent(record, event) {
  const seq = record.nextSeq;
  record.nextSeq += 1;
  return {
    seq,
    type: typeof event?.type === "string" ? event.type : "system",
    timestamp: Date.now(),
    title: typeof event?.title === "string" ? event.title : "",
    message: typeof event?.message === "string" ? event.message : "",
    status: typeof event?.status === "string" ? event.status : "",
    agentId: typeof event?.agentId === "string" ? event.agentId : "",
    agentName: typeof event?.agentName === "string" ? event.agentName : "",
    sessionKey: typeof event?.sessionKey === "string" ? event.sessionKey : "",
    payload: event?.payload && typeof event.payload === "object" ? cloneValue(event.payload) : {}
  };
}

function createRecord(meta = {}) {
  const now = Date.now();
  return {
    debugSessionId: normalizeDebugSessionId(meta.debugSessionId),
    account: typeof meta.account === "string" ? meta.account.trim() || "default" : "default",
    bridgeId: typeof meta.bridgeId === "string" ? meta.bridgeId.trim() : "",
    peerId: typeof meta.peerId === "string" ? meta.peerId.trim() : "",
    agentId: typeof meta.agentId === "string" ? meta.agentId.trim() : "",
    agentName: typeof meta.agentName === "string" ? meta.agentName.trim() : "",
    pushToDevice: Boolean(meta.pushToDevice),
    browserAudio: {
      enabled: Boolean(meta.browserAudio),
      ready: false,
      kind: "",
      text: ""
    },
    deviceDelivery: {
      enabled: Boolean(meta.pushToDevice),
      status: Boolean(meta.pushToDevice) ? "idle" : "disabled",
      message: ""
    },
    latestReplyText: "",
    latestError: "",
    createdAt: now,
    updatedAt: now,
    status: "accepted",
    pending: true,
    nextSeq: 1,
    events: [],
    routeKeys: new Set()
  };
}

export class DebugTraceStore {
  constructor() {
    this.records = new Map();
    this.sessionToDebug = new Map();
  }

  ensureSession(meta = {}) {
    const debugSessionId = normalizeDebugSessionId(meta.debugSessionId);
    if (!debugSessionId) {
      return null;
    }
    const existing = this.records.get(debugSessionId);
    if (existing) {
      existing.account = typeof meta.account === "string" && meta.account.trim()
        ? meta.account.trim()
        : existing.account;
      existing.bridgeId = typeof meta.bridgeId === "string" ? meta.bridgeId.trim() : existing.bridgeId;
      existing.peerId = typeof meta.peerId === "string" && meta.peerId.trim()
        ? meta.peerId.trim()
        : existing.peerId;
      existing.agentId = typeof meta.agentId === "string" && meta.agentId.trim()
        ? meta.agentId.trim()
        : existing.agentId;
      existing.agentName = typeof meta.agentName === "string" && meta.agentName.trim()
        ? meta.agentName.trim()
        : existing.agentName;
      if (meta.pushToDevice !== undefined) {
        existing.pushToDevice = Boolean(meta.pushToDevice);
        existing.deviceDelivery.enabled = Boolean(meta.pushToDevice);
        if (!existing.pushToDevice && existing.deviceDelivery.status === "idle") {
          existing.deviceDelivery.status = "disabled";
        }
      }
      if (meta.browserAudio !== undefined) {
        existing.browserAudio.enabled = Boolean(meta.browserAudio);
      }
      existing.updatedAt = Date.now();
      return existing;
    }
    const record = createRecord(meta);
    this.records.set(debugSessionId, record);
    return record;
  }

  append(debugSessionId, event) {
    const record = this.ensureSession({ debugSessionId });
    if (!record) {
      return null;
    }
    const nextEvent = createEvent(record, event);
    record.events.push(nextEvent);
    record.updatedAt = Date.now();
    return nextEvent;
  }

  accept(meta = {}) {
    const record = this.ensureSession(meta);
    if (!record) {
      return null;
    }
    record.status = "accepted";
    record.pending = true;
    this.append(record.debugSessionId, {
      type: "accepted",
      title: "已受理",
      message: "调试请求已提交，等待 OpenClaw 执行。",
      agentId: record.agentId,
      agentName: record.agentName
    });
    return record;
  }

  attachRoute(debugSessionId, route, meta = {}) {
    const record = this.ensureSession({ debugSessionId, ...meta });
    if (!record || !route) {
      return null;
    }
    for (const key of [route.sessionKey, route.mainSessionKey]) {
      const sessionKey = normalizeSessionKey(key);
      if (!sessionKey) {
        continue;
      }
      record.routeKeys.add(sessionKey);
      this.sessionToDebug.set(sessionKey, record.debugSessionId);
    }
    record.status = "running";
    record.pending = true;
    this.append(record.debugSessionId, {
      type: "agent_bound",
      title: "Agent 已绑定",
      message: record.agentName || record.agentId || "OpenClaw Agent 已就绪",
      agentId: record.agentId,
      agentName: record.agentName,
      sessionKey: normalizeSessionKey(route.sessionKey)
    });
    return record;
  }

  inherit(sourceSessionKey, childSessionKey) {
    const sourceKey = normalizeSessionKey(sourceSessionKey);
    const childKey = normalizeSessionKey(childSessionKey);
    if (!sourceKey || !childKey) {
      return "";
    }
    const debugSessionId = this.sessionToDebug.get(sourceKey) || "";
    if (!debugSessionId) {
      return "";
    }
    const record = this.records.get(debugSessionId);
    if (!record) {
      return "";
    }
    record.routeKeys.add(childKey);
    this.sessionToDebug.set(childKey, debugSessionId);
    record.updatedAt = Date.now();
    return debugSessionId;
  }

  getDebugSessionIdForSession(sessionKey) {
    const key = normalizeSessionKey(sessionKey);
    if (!key) {
      return "";
    }
    return this.sessionToDebug.get(key) || "";
  }

  shouldPushToDevice(debugSessionId) {
    const record = this.records.get(normalizeDebugSessionId(debugSessionId));
    return Boolean(record?.pushToDevice);
  }

  shouldPrepareBrowserAudio(debugSessionId) {
    const record = this.records.get(normalizeDebugSessionId(debugSessionId));
    return Boolean(record?.browserAudio?.enabled);
  }

  recordSubagentSpawned(debugSessionId, payload = {}) {
    return this.append(debugSessionId, {
      type: "subagent_spawned",
      title: "Subagent 已启动",
      message: payload.message || payload.agentName || payload.agentId || payload.sessionKey || "后台任务正在执行",
      agentId: payload.agentId,
      agentName: payload.agentName,
      sessionKey: payload.sessionKey,
      payload
    });
  }

  recordSubagentCompleted(debugSessionId, payload = {}) {
    return this.append(debugSessionId, {
      type: "subagent_completed",
      title: "Subagent 已完成",
      message: payload.message || payload.summary || payload.agentName || payload.agentId || "后台任务已完成",
      agentId: payload.agentId,
      agentName: payload.agentName,
      sessionKey: payload.sessionKey,
      payload
    });
  }

  recordReplyReady(debugSessionId, text) {
    const record = this.ensureSession({ debugSessionId });
    if (!record) {
      return null;
    }
    const normalizedText = typeof text === "string" ? text.trim() : "";
    if (!normalizedText) {
      return null;
    }
    if (record.latestReplyText === normalizedText) {
      return null;
    }
    record.latestReplyText = normalizedText;
    record.updatedAt = Date.now();
    return this.append(record.debugSessionId, {
      type: "reply_ready",
      title: "最终回复已生成",
      message: normalizedText,
      agentId: record.agentId,
      agentName: record.agentName
    });
  }

  recordBrowserAudioReady(debugSessionId, text) {
    const record = this.ensureSession({ debugSessionId });
    if (!record || !record.browserAudio.enabled) {
      return null;
    }
    const normalizedText = typeof text === "string" ? text.trim() : "";
    if (!normalizedText) {
      return null;
    }
    record.browserAudio.ready = true;
    record.browserAudio.kind = "speech-synthesis";
    record.browserAudio.text = normalizedText;
    record.updatedAt = Date.now();
    return this.append(record.debugSessionId, {
      type: "browser_audio_ready",
      title: "浏览器语音已就绪",
      message: "可在调试面板手动播放。",
      payload: {
        kind: record.browserAudio.kind,
        text: normalizedText
      }
    });
  }

  recordBrowserAudioFailed(debugSessionId, message) {
    const record = this.ensureSession({ debugSessionId });
    if (!record || !record.browserAudio.enabled) {
      return null;
    }
    record.browserAudio.ready = false;
    record.updatedAt = Date.now();
    return this.append(record.debugSessionId, {
      type: "browser_audio_failed",
      title: "浏览器语音不可用",
      message: typeof message === "string" ? message : "当前环境无法生成浏览器语音。"
    });
  }

  recordDevicePushStarted(debugSessionId) {
    const record = this.ensureSession({ debugSessionId });
    if (!record) {
      return null;
    }
    record.deviceDelivery.enabled = true;
    record.deviceDelivery.status = "started";
    record.deviceDelivery.message = "";
    record.updatedAt = Date.now();
    return this.append(record.debugSessionId, {
      type: "device_push_started",
      title: "正在推送设备",
      message: "准备把结果同步推送到小智设备。"
    });
  }

  recordDevicePushSucceeded(debugSessionId, payload = {}) {
    const record = this.ensureSession({ debugSessionId });
    if (!record) {
      return null;
    }
    record.deviceDelivery.enabled = true;
    record.deviceDelivery.status = "succeeded";
    record.deviceDelivery.message = typeof payload?.message === "string" ? payload.message : "";
    record.updatedAt = Date.now();
    return this.append(record.debugSessionId, {
      type: "device_push_succeeded",
      title: "设备推送成功",
      message: record.deviceDelivery.message || "结果已推送到当前设备。",
      payload
    });
  }

  recordDevicePushFailed(debugSessionId, message) {
    const record = this.ensureSession({ debugSessionId });
    if (!record) {
      return null;
    }
    record.deviceDelivery.enabled = true;
    record.deviceDelivery.status = "failed";
    record.deviceDelivery.message = typeof message === "string" ? message : "设备推送失败";
    record.updatedAt = Date.now();
    return this.append(record.debugSessionId, {
      type: "device_push_failed",
      title: "设备推送失败",
      message: record.deviceDelivery.message
    });
  }

  markCompleted(debugSessionId) {
    const record = this.ensureSession({ debugSessionId });
    if (!record) {
      return null;
    }
    record.status = "completed";
    record.pending = false;
    record.updatedAt = Date.now();
    return this.append(record.debugSessionId, {
      type: "completed",
      title: "调试完成",
      message: "当前调试会话已结束。"
    });
  }

  markFailed(debugSessionId, message) {
    const record = this.ensureSession({ debugSessionId });
    if (!record) {
      return null;
    }
    const normalized = typeof message === "string" ? message : "调试执行失败";
    record.status = "failed";
    record.pending = false;
    record.latestError = normalized;
    record.updatedAt = Date.now();
    return this.append(record.debugSessionId, {
      type: "failed",
      title: "调试失败",
      message: normalized
    });
  }

  finishIfPending(debugSessionId) {
    const record = this.records.get(normalizeDebugSessionId(debugSessionId));
    if (!record || !record.pending) {
      return null;
    }
    return this.markCompleted(record.debugSessionId);
  }

  getSnapshot(debugSessionId, sinceSeq = 0) {
    const record = this.records.get(normalizeDebugSessionId(debugSessionId));
    if (!record) {
      return null;
    }
    const seq = Number.isFinite(Number(sinceSeq)) ? Number(sinceSeq) : 0;
    const events = record.events
      .filter((event) => event.seq > seq)
      .map((event) => cloneValue(event));
    return {
      ok: true,
      debugSessionId: record.debugSessionId,
      account: record.account,
      bridgeId: record.bridgeId || undefined,
      peerId: record.peerId || undefined,
      agentId: record.agentId || undefined,
      agentName: record.agentName || undefined,
      status: record.status,
      pending: record.pending,
      nextSeq: record.nextSeq,
      latestReplyText: record.latestReplyText,
      latestError: record.latestError,
      browserAudio: cloneValue(record.browserAudio),
      deviceDelivery: cloneValue(record.deviceDelivery),
      updatedAt: record.updatedAt,
      createdAt: record.createdAt,
      events
    };
  }

  clearSessionKeys(sessionKey) {
    const key = normalizeSessionKey(sessionKey);
    if (!key) {
      return;
    }
    this.sessionToDebug.delete(key);
    for (const record of this.records.values()) {
      if (record.routeKeys.has(key)) {
        record.routeKeys.delete(key);
      }
    }
  }

  clear() {
    this.records.clear();
    this.sessionToDebug.clear();
  }
}
