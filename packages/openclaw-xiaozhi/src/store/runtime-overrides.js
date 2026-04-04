export class RuntimeOverrideStore {
  constructor() {
    this.overrides = new Map();
  }

  buildKey(accountId, peerId) {
    return `${accountId || "default"}::${peerId || ""}`;
  }

  get(accountId, peerId) {
    return this.overrides.get(this.buildKey(accountId, peerId)) ?? null;
  }

  set(accountId, peerId, agentId) {
    this.overrides.set(this.buildKey(accountId, peerId), agentId);
  }

  delete(accountId, peerId) {
    this.overrides.delete(this.buildKey(accountId, peerId));
  }

  clear() {
    this.overrides.clear();
  }
}
