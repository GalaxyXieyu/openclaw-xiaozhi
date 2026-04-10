# @galaxyxieyu/xiaozhi

`@galaxyxieyu/xiaozhi` is a native OpenClaw channel plugin for the self-hosted Xiaozhi bridge flow.

It does five things:

1. Keeps an outbound WebSocket connection to `xiaozhi-server`.
2. Handles the JSON-RPC methods `xiaozhi.sessionStarted`, `xiaozhi.sessionEnded`, `xiaozhi.chat`, and `xiaozhi.bindPeerAgent`.
3. Resolves peer-to-agent routing using:
   - runtime overrides: `peer -> agentId`
   - static bindings from config
   - account-level default agent
4. Registers `xiaozhi_push_text`, which lets an agent or subagent proactively push TTS back to the current Xiaozhi device.
5. Registers `xiaozhi_deliver_detail`, which uses OpenClaw's generic `message send` outbound flow to deliver the detailed IM version of a Xiaozhi result to a bound channel/account/target.

## Local development

Install from the workspace:

```bash
openclaw plugins install ./packages/openclaw-xiaozhi
openclaw plugins enable xiaozhi
openclaw gateway restart
```
