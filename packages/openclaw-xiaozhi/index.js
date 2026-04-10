import { createRequire } from "node:module";

import { xiaozhiChannelPlugin } from "./src/channel/xiaozhi-channel.js";
import { XiaozhiBridgeService } from "./src/bridge/client.js";

const require = createRequire(import.meta.url);

function resolveEmptyPluginConfigSchema() {
  try {
    const sdk = require("openclaw/plugin-sdk");
    if (typeof sdk?.emptyPluginConfigSchema === "function") {
      return sdk.emptyPluginConfigSchema();
    }
  } catch {
    // Older OpenClaw hosts may not expose plugin-sdk as a resolvable package.
  }
  return {};
}

function logHostWarning(api, message, error) {
  const finalMessage = error ? `${message}: ${error.message || error}` : message;
  if (typeof api?.logger?.warn === "function") {
    api.logger.warn(`[xiaozhi] ${finalMessage}`);
    return;
  }
  console.warn(`[xiaozhi] ${finalMessage}`);
}

function resolveOutboundPayload(args) {
  const payloads = args.filter((item) => item && typeof item === "object");
  if (!payloads.length) {
    return {};
  }

  const outboundPayload =
    payloads.find((item) =>
      typeof item.text === "string" ||
      typeof item.to === "string" ||
      typeof item.accountId === "string"
    ) ?? payloads[payloads.length - 1];

  const contextPayload =
    payloads.find((item) => item !== outboundPayload) ?? {};

  const rawMedia =
    outboundPayload.mediaItems ||
    outboundPayload.media ||
    outboundPayload.attachments ||
    contextPayload.mediaItems ||
    contextPayload.media ||
    contextPayload.attachments ||
    [];
  const mediaItems = Array.isArray(rawMedia)
    ? rawMedia.filter(Boolean)
    : (rawMedia ? [rawMedia] : []);
  const caption =
    outboundPayload.caption ||
    outboundPayload.altText ||
    contextPayload.caption ||
    contextPayload.altText ||
    "";

  return {
    ...contextPayload,
    ...outboundPayload,
    accountId:
      outboundPayload.accountId ||
      outboundPayload.account ||
      contextPayload.accountId ||
      contextPayload.account ||
      "",
    to:
      outboundPayload.to ||
      outboundPayload.peerId ||
      contextPayload.to ||
      contextPayload.peerId ||
      "",
    text:
      outboundPayload.text ||
      outboundPayload.message ||
      outboundPayload.caption ||
      contextPayload.text ||
      contextPayload.message ||
      caption ||
      "",
    caption,
    mediaItems
  };
}

function createChannelPlugin(service) {
  return {
    ...xiaozhiChannelPlugin,
    outbound: {
      ...(xiaozhiChannelPlugin.outbound || {}),
      sendText: async (...args) => {
        return await service.sendOutboundText(resolveOutboundPayload(args));
      },
      sendMedia: async (...args) => {
        return await service.sendOutboundMedia(resolveOutboundPayload(args));
      }
    }
  };
}

export default {
  id: "xiaozhi",
  name: "Xiaozhi",
  description: "Bridge xiaozhi-server to OpenClaw over outbound WebSocket.",
  configSchema: resolveEmptyPluginConfigSchema(),
  register(api) {
    const service = new XiaozhiBridgeService(api);
    const channelPlugin = createChannelPlugin(service);

    try {
      if (typeof api?.registerChannel === "function") {
        api.registerChannel({ plugin: channelPlugin });
      }
    } catch (error) {
      logHostWarning(api, "registerChannel 不兼容，跳过 channel 注册", error);
    }

    try {
      if (
        typeof api?.registerTool === "function" &&
        typeof service.createPushTextTool === "function"
      ) {
        api.registerTool((ctx) => service.createPushTextTool(ctx));
      }
      if (
        typeof api?.registerTool === "function" &&
        typeof service.createDeliverDetailTool === "function"
      ) {
        api.registerTool((ctx) => service.createDeliverDetailTool(ctx));
      }
    } catch (error) {
      logHostWarning(api, "registerTool 不兼容，跳过 xiaozhi tool 注册", error);
    }

    try {
      if (typeof api?.on === "function" && typeof service.handleAgentEnded === "function") {
        api.on("agent_end", async (event, ctx) => {
          await service.handleAgentEnded(event, ctx);
        });
      }
      if (
        typeof api?.on === "function" &&
        typeof service.handleSubagentSpawned === "function"
      ) {
        api.on("subagent_spawned", (event, ctx) => {
          service.handleSubagentSpawned(event, ctx);
        });
      }
      if (typeof api?.on === "function" && typeof service.handleSessionEnded === "function") {
        api.on("session_end", (_event, ctx) => {
          service.handleSessionEnded(ctx);
        });
      }
    } catch (error) {
      logHostWarning(api, "事件钩子注册失败，已降级为仅保留 bridge service", error);
    }

    api.registerService({
      id: "xiaozhi-bridge",
      start: async () => {
        await service.start();
      },
      stop: async () => {
        await service.stop();
      }
    });
  }
};
