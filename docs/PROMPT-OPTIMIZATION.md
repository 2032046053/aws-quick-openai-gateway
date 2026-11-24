# Claude 请求体与提示词精简

2026-11-24，生产 `/v1/messages` 默认启用。处理位于 bridge 的请求校验之后、会话指纹和历史压缩之前。公网网关继续负责鉴权、用户隔离与流转发；无需增加 Express 服务，也不改变端口、API Key 或 Base URL。Responses、普通 Chat 不应用这些过滤规则。

## 四项规则

1. **固定编码工具白名单**：Read、Write、Edit、Bash、Glob、Grep、NotebookEdit、Agent、Skill、WebSearch、WebFetch、AskUserQuestion、mcp__claude-vscode__getDiagnostics。浏览器、侧栏、调度、工作树编排和其他未列入工具不进入 Quick 工具目录。不会根据每轮关键词随机更换白名单。基础工具完整参数与说明继续通过原来的工具注册表按需加载，没有通过删 schema 来省字节。保留名称不代表所有工具均已逐一执行测试。
2. **技能目录简写**：仅识别系统文本中有边界的技能目录（已知标题下的列表、`<skills>` XML）。保留所有技能名称、一句话用途、路径和非描述字段，涉及审批、安全、禁止事项等行保持原文；存在 Skill 加载器时才处理。使用技能仍需经 Skill 获取完整指令。未知格式、带代码围栏的目录保留。环境中的操作系统、工作目录和路径保持原文，仅去掉完全相同的重复 `<environment_context>`。
3. **重复目录和 UI 指令**：`TOOLS:`、已知 deferred 标题或 `<available-deferred-tools>` 内的纯名称列表，必须全部匹配本次原始 tools 定义才移除；JSON 列表需与原始定义完全匹配。`Starting other sessions`、`Task list and wrap-up (this app)` 必须明确引用本次存在但已过滤的 UI 工具，且不含受保护约束，才移除。未知内容不会被宽泛正则删到文本末尾。正常用户文字、代码、工具参数和工具结果不做上述段落裁剪。
4. **提醒去重**：只处理独立、非代码围栏内的 `<system-reminder>`，相同角色中内容完全相同的副本保留最后一份。不同角色和不同版本的提醒均保留，不会因最新提醒存在而删除所有旧规则。工具调用及结果的 ID、参数、错误标记保持原样。若删除旧重复块导致历史前缀改变，会建立新 Quick 会话，确保完整有效上下文重新发送；此情形不保证原生会话缓存命中。

完整原始请求先经过格式/工具校验，避免过滤时意外隐藏无效 schema。强制调用已禁用工具时直接返回明确的 400，不会偷偷换成别的工具。日志仅输出前后字节数、过滤数量、工具名称和各类命中次数，不输出正文、Key、Cookie 或工具参数。

## SSE 行为

继续逐块转发上游 Content-Type 与正文，等待 drain 处理慢客户端；SSE 响应头立即 flush，并设置 `Cache-Control: no-store, no-transform`、`X-Accel-Buffering: no`。完整动作校验前，Messages 由桥接发送开始事件和等待心跳；有效工具参数分块发送，最后发送 message_stop。这仍不是 Quick 原始 token 的实时透传。

取消绑定到下游 response close 和请求 aborted，不把请求体正常读取结束误判为用户断开。总超时覆盖完整流生命周期，不在刚收到响应头时清除。断线、超时及读取失败均清理上游连接。公网用户 Key 经鉴权后替换为内部 Key，不按示例将任意调用方身份/凭据头直接转发。

## 配置、扩展与回退

服务端环境变量修改后需重启 quick-codex：

```text
QUICK_CLAUDE_PROMPT_OPTIMIZE=1
QUICK_CLAUDE_TOOL_PROFILE=coding
QUICK_CLAUDE_EXTRA_TOOLS=mcp__example__tool1,mcp__example__tool2
```

EXTRA_TOOLS 仅增加指定的精确名称，默认空。需要完整 MCP/桌面工具目录时使用 `QUICK_CLAUDE_TOOL_PROFILE=all`，仍保留技能/重复提醒精简。`QUICK_CLAUDE_PROMPT_OPTIMIZE=0` 可同时关闭四项过滤，回到原来的全工具按需加载机制。此开关不关闭流式心跳，也不更改任何客户端审批。

库调用 createBridge 默认 claudeToolProfile=all，便于已有集成保持兼容；生产 CLI 启动入口默认 coding。可以显式设置 claudeToolProfile、claudeExtraTools 和 promptOptimization。

## 已验证及边界

51 项 Node 测试通过，包括权限约束保留、未知格式、完整 schema、强制工具错误、工具结果关联、去重后的会话恢复，以及 SSE 首事件、断开取消和整流超时。

同一保存的真实 Claude 请求样本：24 个工具缩至 11 个；上一版已启用按需加载的首轮 Quick 提示 9176 字节，本版 7702 字节，减少 16.06%。该样本没有命中 Skills/UI/TOOLS 文本块。另一个专门构造的桌面元数据样本验证四类裁剪，9761 → 2271 字节，减少 76.73%；这不是生产流量平均值。字节数不是账单 token，也不是端到端耗时提升。

公网真实 AWS 测试携带四项裁剪样本，完成外部 Write、实际 UTF-8 文件写入、结果续接及最终结束。首事件约 1.2 秒到达，等待时收到 ping。真实 CLI 公网回归完成 Glob、Read、Edit、Write、Bash 和真实测试输出，退出码 0，耗时 73.8 秒。测试期间为隔离验证所需工具设置了临时 CLI 允许列表，没有修改用户的永久审批规则。

本次优化不会让 Claude Auto 安全分类接口自动兼容 Quick。仍建议使用 Manual，沿用客户端审批；不会精简安全分类规则来伪造放行。AWS 1011 中断、429 限流以及 64 KB 单消息约束仍可能出现。
