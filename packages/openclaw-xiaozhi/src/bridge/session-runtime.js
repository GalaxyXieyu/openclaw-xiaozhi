const XIAOZHI_CHANNEL_ID = "xiaozhi";

export class XiaozhiSessionRuntime {
  constructor({
    api,
    sessionTargets,
    debugTraceStore,
    pushText,
    syncAsyncWaiting
  }) {
    this.api = api;
    this.sessionTargets = sessionTargets;
    this.debugTraceStore = debugTraceStore;
    this.pushTextFn = pushText;
    this.syncAsyncWaitingFn = syncAsyncWaiting;
    this.replyState = new Map();
  }

  clear() {
    this.replyState.clear();
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
        awaitingChildResult: false,
        waitingSignalSent: false,
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
      state.awaitingChildResult = false;
      state.waitingSignalSent = false;
    }
  }

  markRouteSettled(route, text = "") {
    const normalizedText = this.normalizePushText(text);
    const handledDebugSessions = new Set();
    for (const sessionKey of this.getRouteKeys(route)) {
      const state = this.ensureReplyState(sessionKey);
      if (!state) {
        continue;
      }
      state.activeSyncRuns = Math.max(0, state.activeSyncRuns - 1);
      if (normalizedText) {
        state.lastImmediateText = normalizedText;
      }
      const debugSessionId = this.debugTraceStore.getDebugSessionIdForSession(sessionKey);
      if (!debugSessionId || handledDebugSessions.has(debugSessionId) || !normalizedText) {
        continue;
      }
      handledDebugSessions.add(debugSessionId);
      this.api.logger.info(
        `[xiaozhi][debug] route settled session=${sessionKey} debug=${debugSessionId} text=${JSON.stringify(normalizedText.slice(0, 120))}`
      );
      this.debugTraceStore.recordProgress(debugSessionId, {
        sessionKey,
        agentId: route?.agentId || "",
        agentName: route?.agentName || route?.agentId || "",
        message: normalizedText
      });
    }
  }

  async finalizeDebugRoute({ debugSessionId, sessionKey, finalText, state }) {
    this.debugTraceStore.recordReplyReady(debugSessionId, finalText);
    if (this.debugTraceStore.shouldPrepareBrowserAudio(debugSessionId)) {
      this.debugTraceStore.recordBrowserAudioReady(debugSessionId, finalText);
    }

    const shouldPushToDevice = this.debugTraceStore.shouldPushToDevice(debugSessionId);
    if (!shouldPushToDevice) {
      this.debugTraceStore.finishIfPending(debugSessionId);
      return;
    }

    const target = this.sessionTargets.get(sessionKey);
    if (!target) {
      this.debugTraceStore.recordDevicePushFailed(
        debugSessionId,
        "未找到当前调试会话对应的设备上下文。"
      );
      this.debugTraceStore.finishIfPending(debugSessionId);
      return;
    }

    this.debugTraceStore.recordDevicePushStarted(debugSessionId);
    try {
      const pushResult = await this.pushTextFn(
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
          requesterSenderId: target.peerId,
          debugSessionId
        }
      );
      if (pushResult?.queued) {
        if (state) {
          state.lastPushedText = finalText;
        }
        return;
      }
      await this.syncAsyncWaitingFn(
        {
          account: target.account,
          sessionId: target.sessionId,
          deviceId: target.deviceId,
          peerId: target.peerId,
          enabled: false,
          source: "debug-route-finalized",
          reason: "async-reply-delivered"
        },
        {
          sessionKey,
          agentAccountId: target.account,
          requesterSenderId: target.peerId,
          debugSessionId
        }
      );
      if (state) {
        state.lastPushedText = finalText;
      }
      this.debugTraceStore.recordDevicePushSucceeded(debugSessionId, {
        sessionId: target.sessionId,
        deviceId: target.deviceId,
        peerId: target.peerId,
        message: "结果已推送到当前设备。"
      });
      this.debugTraceStore.finishIfPending(debugSessionId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.debugTraceStore.recordDevicePushFailed(debugSessionId, message);
      this.debugTraceStore.finishIfPending(debugSessionId);
      throw error;
    }
  }

  async handleAgentEnded(event, ctx = {}) {
    const sessionKey =
      typeof ctx?.sessionKey === "string" ? ctx.sessionKey.trim() : "";
    if (!sessionKey) {
      return;
    }

    const debugSessionId = this.debugTraceStore.getDebugSessionIdForSession(sessionKey);
    const inferredRootSession = !sessionKey.includes(":subagent:");
    const state = debugSessionId
      ? (this.ensureReplyState(sessionKey) ?? null)
      : (this.replyState.get(sessionKey) ?? null);
    if (state && inferredRootSession) {
      state.isRouteRoot = true;
    }

    const channelId =
      typeof ctx?.channelId === "string" ? ctx.channelId.trim() : "";
    const messageProvider =
      typeof ctx?.messageProvider === "string" ? ctx.messageProvider.trim() : "";
    if (
      !debugSessionId &&
      channelId !== XIAOZHI_CHANNEL_ID &&
      messageProvider !== XIAOZHI_CHANNEL_ID
    ) {
      return;
    }

    const target = this.sessionTargets.get(sessionKey);
    const childSessionKeys = this.extractSpawnedChildSessionKeys(event?.messages);
    const hasChildCompletionEvent = this.hasChildCompletionEvent(event?.messages);
    if (debugSessionId) {
      this.api.logger.info(
        `[xiaozhi][debug] agent_end session=${sessionKey} debug=${debugSessionId} root=${state?.isRouteRoot ? "yes" : "no"} inferredRoot=${inferredRootSession ? "yes" : "no"} children=${childSessionKeys.length} childDone=${hasChildCompletionEvent ? "yes" : "no"} channel=${channelId || "-"} provider=${messageProvider || "-"}`
      );
    }
    if (debugSessionId && state?.isRouteRoot && childSessionKeys.length > 0) {
      state.awaitingChildResult = true;
      for (const childSessionKey of childSessionKeys) {
        this.sessionTargets.inherit(sessionKey, childSessionKey);
        const inheritedDebugSessionId = this.debugTraceStore.inherit(sessionKey, childSessionKey);
        if (inheritedDebugSessionId) {
          this.debugTraceStore.recordSubagentSpawned(inheritedDebugSessionId, {
            sessionKey: childSessionKey,
            message: childSessionKey
          });
          const record = this.debugTraceStore.ensureSession({ debugSessionId: inheritedDebugSessionId });
          if (record) {
            record.pending = true;
            record.status = "running";
            record.updatedAt = Date.now();
          }
        }
      }
    }
    if (debugSessionId && state?.isRouteRoot && childSessionKeys.length > 0 && !hasChildCompletionEvent) {
      return;
    }
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
        if (state?.awaitingChildResult || state?.lastImmediateText) {
          this.api.logger.info(
            `[xiaozhi] keep debug session pending after NO_REPLY session=${sessionKey}`
          );
          return;
        }
        this.debugTraceStore.finishIfPending(debugSessionId);
      }
      return;
    }

    if (state) {
      state.awaitingChildResult = false;
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
      const pushResult = await this.pushTextFn(
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
          requesterSenderId: target.peerId,
          debugSessionId
        }
      );
      if (pushResult?.queued) {
        if (state) {
          state.lastPushedText = finalText;
        }
        this.api.logger.info(
          `[xiaozhi] queued async reply session=${sessionKey} peer=${target.peerId || ""}`
        );
        return;
      }
      await this.syncAsyncWaitingFn(
        {
          account: target.account,
          sessionId: target.sessionId,
          deviceId: target.deviceId,
          peerId: target.peerId,
          enabled: false,
          source: "agent_end",
          reason: "async-reply-delivered"
        },
        {
          sessionKey,
          agentAccountId: target.account,
          requesterSenderId: target.peerId,
          debugSessionId
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

  hasChildCompletionEvent(messages) {
    if (!Array.isArray(messages)) {
      return false;
    }
    return messages.some((entry) => {
      const message =
        entry && typeof entry === "object" && entry.message && typeof entry.message === "object"
          ? entry.message
          : entry;
      if (!message || typeof message !== "object") {
        return false;
      }
      const provenance = message.provenance;
      if (provenance && provenance.kind === "inter_session") {
        return true;
      }
      const text = this.extractRichText(message.content ?? message.text ?? "");
      return text.includes("[Internal task completion event]");
    });
  }

  resolveDebugSessionIdFromPeer(peerId) {
    const normalizedPeerId = typeof peerId === "string" ? peerId.trim() : "";
    if (!normalizedPeerId.startsWith("web-debug:")) {
      return "";
    }
    return normalizedPeerId.slice("web-debug:".length).trim();
  }

  captureDebugOutboundResult(params = {}) {
    const peerId = typeof params?.to === "string" ? params.to.trim() : "";
    const debugSessionId = this.resolveDebugSessionIdFromPeer(peerId);
    if (!debugSessionId) {
      return null;
    }

    const accountId =
      typeof params?.accountId === "string" && params.accountId.trim()
        ? params.accountId.trim()
        : "default";
    const text = this.normalizePushText(
      params?.text || params?.message || params?.caption || ""
    );
    const mediaItems = Array.isArray(params?.mediaItems)
      ? params.mediaItems.filter(Boolean)
      : [];

    this.debugTraceStore.ensureSession({
      debugSessionId,
      account: accountId,
      peerId
    });

    if (text) {
      this.debugTraceStore.recordReplyReady(debugSessionId, text);
      if (this.debugTraceStore.shouldPrepareBrowserAudio(debugSessionId)) {
        this.debugTraceStore.recordBrowserAudioReady(debugSessionId, text);
      }
    } else if (mediaItems.length > 0) {
      this.debugTraceStore.append(debugSessionId, {
        type: "media_result_ready",
        title: "结果附件已生成",
        message: `当前结果包含 ${mediaItems.length} 个附件，调试面板暂只展示文字摘要。`
      });
    }

    this.debugTraceStore.finishIfPending(debugSessionId);
    return {
      ok: true,
      captured: true,
      debugSessionId,
      reason: "debug-session",
      mediaCount: mediaItems.length
    };
  }

  async sendOutboundText(params = {}) {
    const text = typeof params?.text === "string" ? params.text.trim() : "";
    const peerId = typeof params?.to === "string" ? params.to.trim() : "";
    const accountId =
      typeof params?.accountId === "string" && params.accountId.trim()
        ? params.accountId.trim()
        : "default";

    if (!text) {
      return { ok: true, skipped: true, reason: "empty-text" };
    }
    if (!peerId) {
      return { ok: true, skipped: true, reason: "missing-peer" };
    }

    const debugCapture = this.captureDebugOutboundResult({
      ...params,
      accountId,
      to: peerId,
      text
    });
    if (debugCapture) {
      return debugCapture;
    }

    return await this.pushTextFn(
      {
        account: accountId,
        peerId,
        text
      },
      {
        agentAccountId: accountId,
        requesterSenderId: peerId
      }
    );
  }

  async sendOutboundMedia(params = {}) {
    const peerId = typeof params?.to === "string" ? params.to.trim() : "";
    const accountId =
      typeof params?.accountId === "string" && params.accountId.trim()
        ? params.accountId.trim()
        : "default";
    const text = this.normalizePushText(
      params?.text || params?.message || params?.caption || ""
    );
    const mediaItems = Array.isArray(params?.mediaItems)
      ? params.mediaItems.filter(Boolean)
      : [];

    const debugCapture = this.captureDebugOutboundResult({
      ...params,
      accountId,
      to: peerId,
      text,
      mediaItems
    });
    if (debugCapture) {
      return debugCapture;
    }

    if (text) {
      return await this.sendOutboundText({
        ...params,
        accountId,
        to: peerId,
        text
      });
    }

    return {
      ok: true,
      skipped: true,
      reason: "media-unsupported",
      mediaDropped: mediaItems.length > 0
    };
  }

  handleSubagentSpawned(event, ctx = {}) {
    const sourceCandidates = [
      ctx?.requesterSessionKey,
      event?.requesterSessionKey,
      ctx?.requesterMainSessionKey,
      event?.requesterMainSessionKey,
      ctx?.mainSessionKey,
      event?.mainSessionKey
    ]
      .filter((value) => typeof value === "string" && value.trim())
      .map((value) => value.trim());
    const sourceSessionKey = sourceCandidates[0] || "";
    const childSessionKey = ctx?.childSessionKey || event?.childSessionKey;
    const sourceState = this.ensureReplyState(sourceSessionKey);
    if (sourceState) {
      sourceState.awaitingChildResult = true;
    }
    const sourceHasTarget = Boolean(this.sessionTargets.get(sourceSessionKey));
    const sourceHasDebug = this.debugTraceStore.hasSessionKey(sourceSessionKey);
    const inherited = this.sessionTargets.inherit(sourceSessionKey, childSessionKey);
    const debugSessionId = this.debugTraceStore.inherit(sourceSessionKey, childSessionKey);
    this.api.logger.info(
      `[xiaozhi][debug] subagent_spawned sources=${JSON.stringify(sourceCandidates)} child=${childSessionKey || ""} debug=${debugSessionId || ""} inherited=${inherited ? "yes" : "no"} hasTarget=${sourceHasTarget ? "yes" : "no"} hasDebug=${sourceHasDebug ? "yes" : "no"} ctxKeys=${JSON.stringify(Object.keys(ctx || {}))} eventKeys=${JSON.stringify(Object.keys(event || {}))}`
    );
    if (debugSessionId) {
      const record = this.debugTraceStore.ensureSession({ debugSessionId });
      if (record) {
        record.pending = true;
        record.status = "running";
        record.updatedAt = Date.now();
      }
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
    void this.syncAsyncWaitingFn(
      {
        enabled: true,
        source: "subagent_spawned",
        reason: "waiting-child-result"
      },
      {
        sessionKey: sourceSessionKey,
        agentAccountId: inherited?.account,
        requesterSenderId: inherited?.peerId,
        debugSessionId
      }
    );
    if (!inherited) {
      return;
    }
    this.api.logger.info(
      `[xiaozhi] inherited target requester=${sourceSessionKey || ""} child=${childSessionKey || ""} device=${inherited.deviceId || ""} peer=${inherited.peerId || ""}`
    );
  }

  handleSessionEnded(ctx = {}) {
    if (!ctx?.sessionKey) {
      return;
    }
    const debugSessionId = this.debugTraceStore.getDebugSessionIdForSession(ctx.sessionKey);
    const snapshot = debugSessionId
      ? this.debugTraceStore.getSnapshot(debugSessionId)
      : null;
    if (debugSessionId && snapshot?.pending) {
      this.api.logger.info(
        `[xiaozhi][debug] preserve pending session on session_end session=${ctx.sessionKey} debug=${debugSessionId}`
      );
      return;
    }
    if (debugSessionId) {
      this.api.logger.info(
        `[xiaozhi][debug] session_end session=${ctx.sessionKey} debug=${debugSessionId}`
      );
    }
    void this.syncAsyncWaitingFn(
      {
        enabled: false,
        source: "session_end",
        reason: "session-finished"
      },
      {
        sessionKey: ctx.sessionKey,
        debugSessionId
      }
    );
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

  extractSpawnedChildSessionKeys(messages) {
    const keys = new Set();
    const visited = new Set();
    const visit = (value) => {
      if (!value) {
        return;
      }
      if (typeof value === "string") {
        try {
          visit(JSON.parse(value));
        } catch {
          // ignore non-json string payloads
        }
        return;
      }
      if (typeof value !== "object") {
        return;
      }
      if (visited.has(value)) {
        return;
      }
      visited.add(value);

      const directKey =
        typeof value.childSessionKey === "string" ? value.childSessionKey.trim() : "";
      if (directKey) {
        keys.add(directKey);
      }

      const toolName =
        typeof value.toolName === "string"
          ? value.toolName
          : (typeof value.name === "string" ? value.name : "");
      if (toolName === "sessions_spawn") {
        const detailsKey =
          typeof value.details?.childSessionKey === "string"
            ? value.details.childSessionKey.trim()
            : "";
        if (detailsKey) {
          keys.add(detailsKey);
        }
      }

      if (Array.isArray(value)) {
        for (const item of value) {
          visit(item);
        }
        return;
      }

      for (const item of Object.values(value)) {
        visit(item);
      }
    };
    visit(messages);
    return [...keys];
  }
}
