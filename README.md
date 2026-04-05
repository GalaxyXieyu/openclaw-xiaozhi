# OpenClaw Xiaozhi Workspace

This workspace contains two publishable packages:

- `@galaxyxieyu/xiaozhi`
  Native OpenClaw channel plugin. It keeps an outbound WebSocket bridge to `xiaozhi-server`, translates JSON-RPC, and routes each peer to the selected OpenClaw agent.
- `@galaxyxieyu/openclaw-xiaozhi-cli`
  Installer CLI intended for `npx -y --registry=https://registry.npmjs.org @galaxyxieyu/openclaw-xiaozhi-cli@latest install`. It issues a bridge token from `xiaozhi-server`, installs/enables `@galaxyxieyu/xiaozhi`, writes `channels.xiaozhi` config, and restarts the OpenClaw gateway.

## Config shape

The plugin reads account config from `channels.xiaozhi`:

```json
{
  "channels": {
    "xiaozhi": {
      "defaultAccountId": "default",
      "accounts": {
        "default": {
          "enabled": true,
          "serverUrl": "wss://server.example.com/openclaw/bridge/ws",
          "bridgeId": "bridge-abc123",
          "bridgeToken": "secret-token",
          "defaultAgentId": "work-assistant",
          "staticBindings": {
            "AA:BB:CC": "life-assistant"
          }
        }
      }
    }
  }
}
```

`bridgeToken` is issued by `xiaozhi-server` through `POST /admin/openclaw/issue-bridge-token`.
