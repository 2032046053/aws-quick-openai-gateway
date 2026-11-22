# 排障与验证

## 401 / 登录失效

先确认错误来自网关还是后端。公网 401 常见于 Bearer key 被撤销、过期或填错；后端 AWS 登录失效通常表现为 Quick handshake 302/401/403，外层可能转为 502。公网用户 key 与 AWS Cookie 是不同凭据，不要将 Cookie 填入 API key。

## 403

检查错误体：网关 scopes 拒绝与 Cloudflare WAF/机器人检查是不同问题。推荐先用官方 OpenAI SDK 发出最小请求。不要全局关闭已有网站的安全策略；需要调整入口时只针对自己的 API 路径设计规则。

## 413 / 上游 502

Codex 桌面可能携带大量插件和 MCP 工具定义。保持默认核心工具过滤；新开对话、缩短 instructions 和历史，再重试。QUICK_CODEX_TOOLS=all 可能重新引入过长上下文。没有证据证明全部桌面插件链路可靠。

## blocked by policy

这是执行端 Codex 的权限/沙箱问题，不应通过改提示词绕过。Windows demo 启动脚本显式设置 windows.sandbox=elevated，并保留 workspace-write 和 on-request。检查当前 Codex 版本与本机组织策略是否允许该配置。

## 429

降低同时调用数，等待下一分钟。网关默认每 key 一个并发、20 请求/分钟、总共两个并发；原始后端也有独立并发限制。模型生成较慢时，先前请求尚未结束就发下一条可能触发限制。

## SSE 无输出或连接断开

先直连回环 API，再通过 HTTPS 比较。Chat Completions 应有增量；Responses 会先等待 Quick 的完整动作。检查反代缓冲、Cloudflare 连接和超时。基于不稳定 SSH 回程的入口可能在请求中断开，正式服务建议将三层都部署到 VPS。

## Previous response not found

服务重启、缓存被淘汰、换 key 或跨 key 访问均可能导致旧 ID 不可用。新开对话或发送完整历史。不要重复请求别人的 ID。

## 测试命令

```sh
npm run setup
npm test
```

这些都是模拟测试，不需要 AWS 凭据。deploy/github-actions.example.yml 提供 Linux/Windows、Node 22/24 的 CI 矩阵模板。需要时复制到 .github/workflows/test.yml 并启用 Actions；模板尚未运行，不能当成已通过的 CI 结果。

真实登录后可分别运行 quick-proxy/verify-live.mjs、quick-api-gateway/verify-public.mjs。脚本需要对应的本机 client 配置，真实调用会消耗 Quick 额度并创建会话。禁止将“模拟测试通过”描述为“真实 AWS 调用通过”。

## 分享问题信息

提供 Node 版本、服务名、状态码、脱敏日志、最小请求和实际执行记录即可。不要公开 HAR、Cookie、API key、完整项目上下文或开启了动作正文记录的日志。
