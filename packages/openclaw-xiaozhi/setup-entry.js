import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";

import { xiaozhiChannelPlugin } from "./src/channel/xiaozhi-channel.js";

export default defineSetupPluginEntry(xiaozhiChannelPlugin);
