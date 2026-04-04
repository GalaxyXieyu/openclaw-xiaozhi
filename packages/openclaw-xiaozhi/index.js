import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";

import { xiaozhiChannelPlugin } from "./src/channel/xiaozhi-channel.js";
import { XiaozhiBridgeService } from "./src/bridge/client.js";

export default defineChannelPluginEntry({
  id: "xiaozhi",
  name: "Xiaozhi",
  description: "Bridge xiaozhi-server to OpenClaw over outbound WebSocket.",
  plugin: xiaozhiChannelPlugin,
  registerCliMetadata(api) {
    api.registerCli(
      ({ program }) => {
        program
          .command("xiaozhi")
          .description("Inspect xiaozhi bridge status inside OpenClaw");
      },
      {
        descriptors: [
          {
            name: "xiaozhi",
            description: "Inspect xiaozhi bridge status inside OpenClaw",
            hasSubcommands: false
          }
        ]
      }
    );
  },
  registerFull(api) {
    const service = new XiaozhiBridgeService(api);
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
});
