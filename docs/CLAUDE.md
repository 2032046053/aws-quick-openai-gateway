# Claude Code 接入 Quick

大文件读取和连续自动压缩问题已更新为[分页读取与可靠摘要](LARGE-FILE-CONTEXT.md)：默认文本 Read 最多 120 行，旧长读取按剩余字节预算节流，摘要必须实际装入预算；该说明优先于本文较早的 24000 字符保留和摘要上限描述。

生产服务现已默认启用[请求体与提示词精简](PROMPT-OPTIMIZATION.md)：编码工具白名单、技能目录简写、受限 UI/重复工具目录移除和相同提醒去重。该说明优先于本文较早的“所有工具默认保留”描述；需要其他 MCP 工具可配置服务端额外白名单或 all 模式。

本适配将 Anthropic Messages 转为现有 Quick 外部工具协议。实际模型仍是 AWS Quick；Claude 模型名称仅用于客户端兼容，不代表调用 Anthropic 模型。

## 部署

在原部署中更新 bridge/adapter.mjs、bridge/prompts.mjs，新增 bridge/anthropic.mjs、bridge/context.mjs，更新 quick-api-gateway/gateway.mjs。保留所有私有配置。重启 quick-codex 与 quick-gateway 后生效。后端和现有 Responses 接口不需要替换。本版已同步服务器。

## Claude Code 配置（PowerShell）

```powershell
$env:ANTHROPIC_BASE_URL = "https://moyubooks.icu/quick"
$env:ANTHROPIC_AUTH_TOKEN = "<现有用户 API key>"
$env:ANTHROPIC_MODEL = "quick"
$env:ANTHROPIC_DEFAULT_OPUS_MODEL = "quick"
$env:ANTHROPIC_DEFAULT_SONNET_MODEL = "quick"
$env:ANTHROPIC_DEFAULT_HAIKU_MODEL = "quick"
$env:CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1"
claude --model quick
```

清除已有 ANTHROPIC_API_KEY 或其他供应商变量，避免旧配置覆盖。客户端需关闭扩展/自适应 thinking。若版本支持 `/effort`，这并不等于关闭 thinking；以实际发出的请求为准。Claude Code 版本可能有额外要求，本轮未在真实 Claude Code 中验证。

本机直连将 BASE_URL 改为 `http://127.0.0.1:8788` 并使用本机内部 key。公网用户 key 必须有 `responses` scope。支持 Bearer 与 x-api-key 认证；公网网关始终替换为内部 key 并绑定真实用户，禁止调用者伪造 principal。

## 支持及限制

- 文本 system/messages、普通 JSON schema 工具、tool_use/tool_result（含 is_error）。Bash、Read、Write、Edit、Grep、Glob 和 MCP 工具按请求实际 schema 转发，不受 Codex 核心工具白名单过滤；原样保留工具描述与参数约束。
- 工具由 Claude Code 本地执行，沿用客户端审批；服务端只生成调用。每轮最多一个工具动作。
- 支持非流式 JSON 与标准 Messages SSE 事件。请求校验、历史压缩结束后立即发 message_start，等待生成时每 10 秒发 ping。完整动作校验通过后分块发送正文/工具参数并发 message_stop；不是 Quick 逐 token 透传。
- tool_choice auto/none/any/tool；不满足强制工具选择时显式报错。
- 不支持图片、PDF、扩展 thinking、Anthropic 托管工具、真实 token 统计。usage 返回 0；max_tokens 仅校验格式，不能控制 Quick 的精确生成上限。模型别名均映射同一 Quick 后端。
- Claude 工具结果上限改为 24000 字符，超限保留头尾；Codex 默认仍为 2000 字符；大文件需分段读取。超大动态工具集仍可能触发现有上下文上限。
- 尚未实现 count_tokens，客户端必须容忍其不可用；未承诺 Claude Code 所有版本/插件全部兼容。
- Claude 官网/桌面普通聊天页不能通过这些环境变量使用自定义 API。

## 验证

`npm test` 包含 Messages 工具往返、流事件、认证、强制工具修复、调用 ID 关联、重复/缺失结果拒绝、参数约束、中文多行编辑、大文件中间内容保留和 MCP 名称保留。编码 harness 实际在临时目录执行 Write → Read → Edit → Node 命令，得到 437 后回传工具结果；模型决策使用模拟 Quick 上游，不等于真实 AWS/Claude Code 整链路验证。

参数校验覆盖常见 type/required/enum/const、嵌套对象/数组、数值及长度范围、additionalProperties、anyOf/oneOf/allOf；不是完整 JSON Schema 校验器。未实现的约束仍保留在模型工具签名中。历史可包含多项工具及其结果，新回复仍只产生一个工具动作。

## VS Code + API Key 自动压缩

适用于 VS Code 中使用本服务 Messages API 的 Claude Code 客户端。压缩在 API 服务端完成，不要求插件先触发 `/compact`，不依赖 usage=0 的 token 统计，也不会减少 VS Code 本地显示的聊天记录。当前改动已部署，登录恢复后需以在线验证记录确认实际状态。

默认开启：工具结果先按 24000 字符限制处理；处理后的完整历史 JSON 超过默认 48000 UTF-8 字节（也受系统指令与工具定义剩余预算约束），才尝试摘要旧记录。保留至少末尾 2 项事件及近期记录，在预算允许时保留约 16000 字节，在已闭合的工具调用/结果边界切分。系统指令、工具 schema、当前 tool_choice 始终完整保留。摘要要求保留任务、约束、改动路径、命令、真实结果、错误和待办。摘要可能遗漏细节，编辑前仍应重新读取相关文件。

压缩摘要使用相同 Quick 后端额外请求，第一次有延迟与额度开销；摘要缓存按已认证用户、工具设置和精确历史隔离，最多保留 100 项，仅在内存中保存。历史改变后按需生成新摘要并使用新的 Quick 会话；普通增量请求继续复用会话。不会把压缩指令写进用户 API Key，不需要重发 key。

服务端环境变量：

```text
QUICK_CLAUDE_AUTO_COMPACT=1
QUICK_CLAUDE_CONTEXT_BYTES=48000
```

设 `QUICK_CLAUDE_AUTO_COMPACT=0` 可关闭；阈值单位是 UTF-8 字节，不是真实模型 token。AWS 单条消息上限为 64 KB；旧记录分批摘要，摘要输入设有单独字节上限，总提示超过安全预算时明确报 413。仅作用于 `/v1/messages`，Responses 保持原行为。若单个近期事件太大、不能安全切分，保留原记录并沿用现有上下文上限错误；不会为达到预算而拆散工具对。摘要失败显式报错，不静默丢弃历史。

响应头 `x-quick-context-compacted: true` 和 `x-quick-context-chars` 可确认服务端压缩；日志只记录前后字符数、字节数和轮数，不打印摘要或 key。

当前机器的 Claude 配置使用 `http://127.0.0.1:65535`（CC Switch）。本轮保留该地址、密钥与模型配置。需要在 CC Switch 中将 Claude 当前供应商路由到部署后的 Quick Messages 地址，或按上面的接入示例配置独立终端后再启动 VS Code。不要仅把现有供应商的 key 换到另一地址。公网 Messages 编码工具已完成真实 AWS 与执行结果续接验证；真实 VS Code 扩展本身尚未验证。


## 登录刷新状态

2026-11-23 已提取浏览器当前会话并验证后同步至 VPS，原 API Key、自定义代理及其他配置均保留。公网 Chat、Responses、Claude Bash 调用与 SSE 续接通过，服务器实际命令输出为 527。在线压缩测试发现并修复 AWS 64 KB 单消息限制，采用 UTF-8 字节预算和分批摘要。详细状态见本次在线验证 JSON。


## 完整工具按需加载（2026-11-24）

现已部署目录与完整定义按需加载；大工具集不再每次引导时展开所有参数和长说明。详见 [工具目录方案](TOOL-REGISTRY.md)，该说明优先于上文工具说明预算和完整 schema 内联的描述。API Key 无需更换。

## 网页已有代码但 Claude 仍加载（2026-11-24）

已确认一次真实故障：Quick 网页显示长代码后，WebSocket 在约 61 秒以 1011 Tenant service stream error 断开，后端没有收到完整结束事件。旧桥接把它作为 502 返回，客户端反复重试，造成约十分钟的等待。网页存在文本不等于外部工具动作已完成，也不能证明本地文件已写入。

Messages 现在提前发送 message_start、等待时发送 ping，完整参数按每段最多 1024 个 JavaScript 字符发送。精确匹配的 AWS 1011 中断返回明确错误（非流式 HTTP 422 / 流式 error invalid_request_error），不发伪成功或残缺工具调用。真实 Claude CLI 2.1.330 在模拟故障下退出 1，进行了两次上游调用（包含客户端回退），没有长时间重试；不能保证其他客户端版本行为一致。

给 Write/Edit/NotebookEdit 增加小步修改提示，建议 Read 后使用局部 Edit，每次生成内容约 6000 字符以内；这是模型提示，不是强制截断。high 思考设置不变。AWS 本身仍可能中断，心跳不能修复上游生成失败。完整工具内容仍须等待有效动作后才能交付。

44 项回归通过；真实 CLI 经模拟上游完整写入 22000 字节中文/表情内容并正常结束。公网真实 AWS 验证收到 message_start、ping、分块工具参数与 message_stop，执行 Write 后工具结果续接成功。流式响应开始后才知道的工具目录/会话统计改由服务端日志记录，非流式响应继续提供相关响应头。
