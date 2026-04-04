# @openclaw/xiaozhi

`@openclaw/xiaozhi` is a native OpenClaw channel plugin for the self-hosted Xiaozhi bridge flow.

It does three things:

1. Keeps an outbound WebSocket connection to `xiaozhi-server`.
2. Handles the JSON-RPC methods `xiaozhi.sessionStarted`, `xiaozhi.sessionEnded`, `xiaozhi.chat`, and `xiaozhi.bindPeerAgent`.
3. Resolves peer-to-agent routing using:
   - runtime overrides: `peer -> agentId`
   - static bindings from config
   - account-level default agent

## Local development

Install from the workspace:

```bash
openclaw plugins install ./packages/openclaw-xiaozhi
openclaw plugins enable xiaozhi
openclaw gateway restart
```
