# 协议与兼容范围

## 真正的对话通道

```text
wss://quick.aws.com/sn/account/{accountId}/wsproxy/service/SpaceNeedleConversationService/operation/ChatBidirectionalStream
```

查询参数包括 wsproxy-protocol=rpc-v2-cbor、awsAccountId、surfaceType=WEB_EXPERIENCE、agentServiceType=UNIFIED_QUICK、outpostId=web0、workingSessionId、mbtc。

握手还使用 Cookie 和两个子协议：subprotocol-json，以及 URL 编码的 csrfToken JSON 对象。子协议内保留 csrfToken 请求头原来的百分号编码；查询参数则经过 URLSearchParams 编码一次，避免重复编码。

## 二进制消息层次

```text
WebSocket binary message
  → AWS EventStream：长度、headers、prelude CRC、message CRC
  → CBOR map：payload 为字节串
  → JSON：type、payload、thread_id、message_id 等
```

输入使用 rawInputEvent，输出使用 rawOutputEvent。观察到的流程为 session_connect → connected → user_message → message_start → text_delta → message_complete。另有 keepalive、status、usage 等事件。

EventDecoder 支持拆分/合并的 EventStream 帧，验证 CRC 并限制帧大小。客户端使用新 UUID 创建每个请求的独立会话，并忽略无关线程与非 chat scope 的事件。

invocations/api/ws-rpc 是辅助 JSON 接口，曾观察到 type=get_settings；它不是核心聊天入口。server.mjs 保留最初的协议透明隧道，与 OpenAI 适配 API 是不同入口。

## Chat Completions

- 文本消息支持 system、developer、user、assistant 和 type=text 内容块。
- system/developer 合并到 Quick custom_prompt，角色优先级不保证等价于 OpenAI。
- 多轮历史编码为带角色的 JSON 文本，发送给新 Quick 会话；没有完整的原生角色映射。
- text_delta 映射为 SSE delta，最终 message_complete 用于校验和补齐文本。
- token usage 未映射，不伪造统计。
- 不实现图片、音频、原生工具、采样参数、停止词、Responses API 或 embeddings；Responses 由另一层提供。

## Codex Responses

适配器将 instructions、工具 schema 和工具结果历史组合成提示词，要求 Quick 输出一个 JSON 动作：tool_call、custom_tool_call 或 message。经过解析和工具名称检查后转换成 Responses output item/SSE 事件。

这不是 Quick 原生 function calling，工具参数的完整 schema 校验和执行仍由调用端负责。每次一个动作；不支持真正并行工具调用。Quick 输出先完整缓冲，再转换 Responses 事件，因此 Responses 不是 token 级实时输出。

默认保留核心编程工具，避免桌面插件/MCP schema 造成超长提示。当前实验保护上限为 4 MiB 请求体、350000 字符提示、120 秒请求、两个并发；这些数值不是 AWS 上下文窗口或服务承诺。

previous_response_id 仅保留进程内最近 100 个响应。网关另外校验 key 归属；网关重启后归属表同样丢失。

## 真实性与隔离边界

模型输出的“命令执行成功”不证明真的有工具调用。曾出现修改文件后没有运行测试，却编造测试输出的情况；应检查调用端记录。

每个 key 的历史接口隔离不等同于独立 AWS 租户。多个用户共享同一个 AWS 账户权限和额度；高隔离需求应使用独立后端/账户。
