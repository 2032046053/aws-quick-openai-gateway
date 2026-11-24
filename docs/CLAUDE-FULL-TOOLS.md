# Claude 完整编码工具修复（2026-11-24）

真实 CLI 抓取到 24 个工具，原始请求约 91 KB。已为工具说明设总预算并缩短长说明，保留全部名称、参数 schema 与约束；修复客户端 messages 中 system 角色导致的 400。未开放 Anthropic 托管工具，也未承诺所有插件都兼容。

本机移除当前供应商与 Claude 设置中的 CLAUDE_CODE_SIMPLE 精简模式，并关闭 ENABLE_TOOL_SEARCH 延迟搜索，完整工具直接发送。VS Code 环境同步设置。重启 CC Switch/重载 VS Code 后应用；密钥未变。CC Switch 数据库修改已私有备份，运行中的应用可能保有旧内存配置，重启后再确认。

服务器已部署 bridge/anthropic.mjs。36 项回归通过。真实 Claude CLI 携带 24 工具目录，经公网 Quick high 后端实际执行 Read→Write，result.txt 内容为 FULL_TOOLS_FIXTURE_OK。不是 24 个工具逐一执行，也不是所有 MCP 插件的完整验证。

测试期间发现 CC Switch 本机代理端口暂时拒绝连接，因此最终完整 CLI 验证使用临时本机捕获转发器直接到同一公网网关；生产配置仍指向 CC Switch，没有改用该临时端口。
