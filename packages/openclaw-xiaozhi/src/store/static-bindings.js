function normalizeObjectBindings(bindings) {
  if (!bindings || typeof bindings !== "object" || Array.isArray(bindings)) {
    return null;
  }
  return bindings;
}

function normalizeArrayBindings(bindings) {
  if (!Array.isArray(bindings)) {
    return null;
  }
  const result = {};
  for (const item of bindings) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const peerId = typeof item.peerId === "string" ? item.peerId.trim() : "";
    const agentId = typeof item.agentId === "string" ? item.agentId.trim() : "";
    if (peerId && agentId) {
      result[peerId] = agentId;
    }
  }
  return result;
}

export function resolveStaticBinding(accountConfig, peerId) {
  const mappings =
    normalizeObjectBindings(accountConfig?.staticBindings) ??
    normalizeObjectBindings(accountConfig?.bindings) ??
    normalizeArrayBindings(accountConfig?.staticBindings) ??
    normalizeArrayBindings(accountConfig?.bindings) ??
    {};
  return typeof mappings[peerId] === "string" ? mappings[peerId] : null;
}
