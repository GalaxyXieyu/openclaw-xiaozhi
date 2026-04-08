const DEFAULT_ACCOUNT_ID = "default";

function resolveChannelSection(cfg) {
  return cfg?.channels?.xiaozhi ?? {};
}

function listAccountIds(section) {
  const ids = Object.keys(section?.accounts ?? {});
  if (ids.length > 0) {
    return ids;
  }
  return [section?.defaultAccountId ?? DEFAULT_ACCOUNT_ID];
}

function hasText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeAccountConfig(accountId, section) {
  const accounts = section?.accounts ?? {};
  const fallbackAccountId = section?.defaultAccountId ?? DEFAULT_ACCOUNT_ID;
  const resolvedAccountId = accountId ?? fallbackAccountId;
  const accountConfig = accounts?.[resolvedAccountId] ?? {};
  return {
    accountId: resolvedAccountId,
    ...accountConfig
  };
}

const meta = {
  id: "xiaozhi",
  label: "Xiaozhi",
  selectionLabel: "Xiaozhi",
  blurb: "Bridge xiaozhi-server to OpenClaw over outbound WebSocket."
};

export const xiaozhiChannelPlugin = {
  id: "xiaozhi",
  meta,
  capabilities: {
    chatTypes: ["direct"],
    media: false,
    polls: false,
    reactions: false,
    threads: false,
    nativeCommands: false
  },
  reload: {
    configPrefixes: ["channels.xiaozhi"]
  },
  config: {
    listAccountIds(cfg) {
      return listAccountIds(resolveChannelSection(cfg));
    },
    resolveAccount(cfg, accountId) {
      return normalizeAccountConfig(accountId, resolveChannelSection(cfg));
    },
    inspectAccount(cfg, accountId) {
      const account = normalizeAccountConfig(accountId, resolveChannelSection(cfg));
      const hasToken = hasText(account.bridgeToken);
      const hasServerUrl = hasText(account.serverUrl);
      return {
        accountId: account.accountId,
        enabled: account.enabled !== false,
        configured: hasToken && hasServerUrl,
        bridgeId: account.bridgeId || null,
        tokenStatus: hasToken ? "available" : "missing"
      };
    },
    defaultAccountId(cfg) {
      return resolveChannelSection(cfg)?.defaultAccountId ?? DEFAULT_ACCOUNT_ID;
    },
    isEnabled(account) {
      return account?.enabled !== false;
    },
    isConfigured(account) {
      return hasText(account?.bridgeToken) && hasText(account?.serverUrl);
    },
    describeAccount(account) {
      return {
        accountId: account.accountId,
        name: account.name || account.bridgeId || account.accountId,
        enabled: account.enabled !== false,
        configured: hasText(account?.bridgeToken) && hasText(account?.serverUrl)
      };
    }
  }
};
