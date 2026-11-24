# Quick high 思考模式（2026-11-24）

服务器默认 thinking_effort 已由 off 改为 high，源码与服务器同步。公网 Claude 工具调用、真实 Node 执行 37*13=481、结果续接通过，本地 34 项回归通过。原 API Key 不变。

Quick 客户端配置 thinkingEffort 可选择 off/low/medium/high/max，默认 high；更改私有 session.local.json 后重启 quick-backend 生效。max 曾出现 AWS 1011 流错误，本轮未启用。

这是 AWS Quick 后端思考，Claude 客户端无需开启 Anthropic thinking。当前接口只返回最终文本和工具调用，不转发 Quick thinking_delta，也不伪造 Anthropic thinking/signature 块。不要在 Claude 端开启原生扩展 thinking，否则现有适配器会拒绝。

本次重启清空后端内存会话；客户端可重新发送完整历史恢复。
