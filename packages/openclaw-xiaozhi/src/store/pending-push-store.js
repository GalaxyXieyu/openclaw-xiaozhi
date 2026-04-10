import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function resolveStateFile() {
  const baseDir =
    (typeof process.env.OPENCLAW_STATE_DIR === "string" && process.env.OPENCLAW_STATE_DIR.trim()) ||
    path.join(os.homedir(), ".openclaw");
  const dir = path.join(baseDir, "cache", "xiaozhi");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "pending-pushes.json");
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeFingerprint(item = {}) {
  return [
    normalizeText(item.account),
    normalizeText(item.sessionId),
    normalizeText(item.deviceId),
    normalizeText(item.peerId),
    normalizeText(item.text).replace(/\s+/g, " ")
  ].join("::");
}

function createEntry(item = {}) {
  const now = Date.now();
  return {
    id: `push-${now}-${Math.random().toString(16).slice(2, 10)}`,
    account: normalizeText(item.account) || "default",
    sessionId: normalizeText(item.sessionId) || "",
    deviceId: normalizeText(item.deviceId) || "",
    peerId: normalizeText(item.peerId) || "",
    text: normalizeText(item.text),
    sessionKey: normalizeText(item.sessionKey) || "",
    debugSessionId: normalizeText(item.debugSessionId) || "",
    createdAt: now,
    updatedAt: now,
    nextAttemptAt: now,
    attempts: 0,
    lastError: ""
  };
}

export class PendingPushStore {
  constructor() {
    this.stateFile = resolveStateFile();
    this.entries = [];
    this.loadFromDisk();
  }

  loadFromDisk() {
    if (!fs.existsSync(this.stateFile)) {
      return;
    }
    try {
      const raw = fs.readFileSync(this.stateFile, "utf8");
      if (!raw.trim()) {
        this.entries = [];
        return;
      }
      const parsed = JSON.parse(raw);
      this.entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
    } catch {
      this.entries = [];
    }
  }

  persistToDisk() {
    fs.writeFileSync(this.stateFile, JSON.stringify({ entries: this.entries }), "utf8");
  }

  enqueue(item = {}) {
    this.loadFromDisk();
    const entry = createEntry(item);
    if (!entry.text) {
      return null;
    }
    const fingerprint = normalizeFingerprint(entry);
    const existing = this.entries.find((queued) => normalizeFingerprint(queued) === fingerprint);
    if (existing) {
      return existing;
    }
    this.entries.push(entry);
    this.persistToDisk();
    return entry;
  }

  list() {
    this.loadFromDisk();
    const now = Date.now();
    return this.entries
      .filter((item) => Number(item.nextAttemptAt || 0) <= now)
      .sort((left, right) => {
      if (left.createdAt !== right.createdAt) {
        return left.createdAt - right.createdAt;
      }
      return String(left.id).localeCompare(String(right.id));
      });
  }

  remove(id) {
    this.loadFromDisk();
    const normalizedId = normalizeText(id);
    if (!normalizedId) {
      return;
    }
    this.entries = this.entries.filter((item) => item.id !== normalizedId);
    this.persistToDisk();
  }

  markAttempt(id, errorMessage = "") {
    this.loadFromDisk();
    const normalizedId = normalizeText(id);
    const target = this.entries.find((item) => item.id === normalizedId);
    if (!target) {
      return null;
    }
    target.attempts = Number(target.attempts || 0) + 1;
    target.lastError = normalizeText(errorMessage);
    target.updatedAt = Date.now();
    target.nextAttemptAt = Date.now() + Math.min(30000, 1500 * (2 ** Math.min(target.attempts, 4)));
    this.persistToDisk();
    return target;
  }
}
