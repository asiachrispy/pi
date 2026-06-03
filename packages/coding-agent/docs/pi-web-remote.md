# pi-web 远程部署

pi-web 可在局域网或 VPN（推荐 Tailscale）上提供完整 Web 控制台。pi CLI 本身无 HTTP 服务；远程能力由 [pi-web](https://github.com/badlogic/pi-mono) 提供。

## 启动

```bash
pi-web --remote --hostname 0.0.0.0
```

在 pi-web **Settings → Remote access** 中开启远程、生成配对 QR/链接，用手机或其他电脑配对后即可使用。

详细说明见 pi-web 仓库 `docs/remote-access.md`。

## OAuth 回调（远程配置 API Key）

Provider OAuth 默认监听 `127.0.0.1`。若需在远程设备上完成 OAuth（不推荐），可将回调 host 设为 Tailscale 地址：

```bash
export PI_OAUTH_CALLBACK_HOST=100.x.y.z   # 或 tailnet MagicDNS 名称
pi-web --remote --hostname 100.x.y.z
```

更安全的做法：在 Host 本机浏览器中打开 pi-web Settings → Models，完成 OAuth / API Key 配置；远程设备复用已保存的 `~/.pi/agent` 凭证。

## 数据目录

会话与远程配置均在 agent 目录：

- 会话：`$PI_CODING_AGENT_DIR/sessions/`（默认 `~/.pi/agent/sessions/`）
- 远程配置：`$PI_CODING_AGENT_DIR/pi-web-remote.json`

## RPC / SDK

第三方集成仍可使用 `pi --mode rpc` 或 `createAgentSession()` SDK。远程 pi-web 走 HTTP+SSE，不替代 RPC 协议。

RPC 现已支持 pi-web 同款命令：`navigate_tree`、`get_tools`、`set_tools`（见 [rpc.md](../docs/rpc.md)）。
