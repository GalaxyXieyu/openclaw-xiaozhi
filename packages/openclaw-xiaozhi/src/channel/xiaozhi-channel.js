import {
  createChannelPluginBase,
  createChatChannelPlugin
} from "openclaw/plugin-sdk/channel-core";

function resolveChannelSection(cfg) {
  return cfg?.channels?.xiaozhi ?? {};
}

function normalizeAccountConfig(accountId, section) {
  const accounts = section?.accounts ?? {};
  const fallbackAccountId = section?.defaultAccountId ?? "default";
  const resolvedAccountId = accountId ?? fallbackAccountId;
  const accountConfig = accounts?.[resolvedAccountId] ?? {};
  return {
    accountId: resolvedAccountId,
    ...accountConfig
  };
}

export const xiaozhiChannelPlugin = createChatChannelPlugin({
  base: createChannelPluginBase({
    id: "xiaozhi",
    setup: {
      resolveAccount(cfg, accountId) {
        const section = resolveChannelSection(cfg);
        return normalizeAccountConfig(accountId, section);
      },
      inspectAccount(cfg, accountId) {
        const section = resolveChannelSection(cfg);
        const account = normalizeAccountConfig(accountId, section);
        const hasToken = Boolean(account.bridgeToken);
        const hasServerUrl = Boolean(account.serverUrl);
        return {
          enabled: Boolean(account.enabled),
          configured: hasToken && hasServerUrl,
          tokenStatus: hasToken ? "available" : "missing"
        };
      }
    }
  })
});
