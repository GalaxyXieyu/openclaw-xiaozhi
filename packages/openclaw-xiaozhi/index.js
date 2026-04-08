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

export default {
  id: "xiaozhi",
  name: "Xiaozhi",
  description: "Bridge xiaozhi-server to OpenClaw over outbound WebSocket.",
  configSchema: resolveEmptyPluginConfigSchema(),
  register(api) {
    const service = new XiaozhiBridgeService(api);

    try {
      if (typeof api?.registerChannel === "function") {
        api.registerChannel({ plugin: xiaozhiChannelPlugin });
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
    } catch (error) {
      logHostWarning(api, "registerTool 不兼容，跳过 push text tool 注册", error);
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
