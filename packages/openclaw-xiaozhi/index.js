import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";

import { xiaozhiChannelPlugin } from "./src/channel/xiaozhi-channel.js";
import { XiaozhiBridgeService } from "./src/bridge/client.js";

export default {
  id: "xiaozhi",
  name: "Xiaozhi",
  description: "Bridge xiaozhi-server to OpenClaw over outbound WebSocket.",
  configSchema: emptyPluginConfigSchema(),
  register(api) {
    api.registerChannel({ plugin: xiaozhiChannelPlugin });
    const service = new XiaozhiBridgeService(api);
    api.registerTool((ctx) => service.createPushTextTool(ctx));
    api.on("subagent_spawned", (event, ctx) => {
      service.handleSubagentSpawned(event, ctx);
    });
    api.on("session_end", (_event, ctx) => {
      service.handleSessionEnded(ctx);
    });
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
