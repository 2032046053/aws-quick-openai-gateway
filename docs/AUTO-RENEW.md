# AWS Quick 自动续期（2026-11-24）

当前会话已刷新并同步服务器，原 API Key 和自定义代理均保留。公网 Chat、Responses、Claude 工具调用及 SSE 续接通过。

服务器启用 quick-session-renew.timer，每十分钟（加最多三十秒随机延迟）运行 quick-session-renew.service。脚本携带现有 Cookie 请求 AWS Quick 已登录页面，合并 AWS 下发的 Set-Cookie，并读取页面 CSRF；新会话须通过真实 WebSocket 握手，才能原子替换私有配置。失败保留旧会话。后端每次请求读取最新 Cookie/CSRF，保留原生会话缓存，无须续期时重启。

两次实际续期均确认 cookieChanged=true、handshakeValidated=true；systemd 执行 Result=success。续期后的公网 Messages 返回 200 和预期文本。完整本地 Node 回归 34/34 通过。

边界：这是现有 AWS 网站登录会话的自动更新，不是保存密码自动登录，也没有 OAuth refreshToken。上层 AWS/身份提供商凭据绝对到期、撤销、账号变更或要求 MFA 时，仍需用户重新登录。当前只验证立即更新成功，尚未经过完整过夜周期，不能保证无限续期。

只读状态命令：

```sh
systemctl status quick-session-renew.timer --no-pager
cat /opt/quick-api/state/session-renew-status.json
journalctl -u quick-session-renew.service -n 10 --no-pager
```

状态文件不含 Cookie。reason=login_required 时需要刷新浏览器登录；不会跟随登录跳转、猜测密码或打印凭据。续期脚本仅在服务器内部运行，未新增公网刷新入口。

代码：scripts/renew-session.py、quick-proxy/validate-session.mjs；quick-client.mjs/api-server.mjs 增加登录字段热加载与账户变更拒绝。
