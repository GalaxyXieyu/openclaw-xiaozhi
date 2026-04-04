# @openclaw/xiaozhi-cli

Intended usage:

```bash
npx -y @openclaw/xiaozhi-cli@latest install
```

The CLI will:

1. ask for `xiaozhi-server` domain and admin key
2. issue a bridge token
3. install and enable `@openclaw/xiaozhi`
4. write `channels.xiaozhi` config
5. restart the OpenClaw gateway
