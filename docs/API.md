# API 与密钥管理

## 客户端配置

```json
{
  "baseURL": "https://api.example.com/quick/v1",
  "apiKey": "填入管理员为你生成的个人密钥",
  "model": "quick"
}
```

客户端使用 Bearer 认证。模型名不是 gpt-4 或 gpt-5，必须填写 quick；Responses 适配器还接受 quick-codex，但推荐统一 quick。

## curl 示例

```sh
export QUICK_USER_KEY='你自己的用户密钥'
curl https://api.example.com/quick/v1/chat/completions \
  -H "Authorization: Bearer $QUICK_USER_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"quick","messages":[{"role":"user","content":"你好"}],"stream":false}'
```

流式将 stream 设为 true，使用 `curl -N`。Responses 示例：

```json
{"model":"quick","input":"你好","tools":[],"tool_choice":"none"}
```

工具模式下可携带外部 function/custom 工具定义。模型返回动作后由调用者自己的 harness 执行，结果作为 function_call_output/custom_tool_call_output 续传。

## 管理用户 key

本地开发时在 quick-api-gateway 目录运行：

```sh
node keys.mjs create alice
node keys.mjs list
node keys.mjs revoke <UUID>
```

VPS 安装器提供 quick-key，或从 Windows 使用：

```powershell
.\Manage-Keys.ps1 -SshHost your-vps -Action Create -Value alice
.\Manage-Keys.ps1 -SshHost your-vps -Action List
.\Manage-Keys.ps1 -SshHost your-vps -Action Revoke -Value 对应UUID
```

Create 将用户配置下载至本机 clients 目录。只将对应配置交给该用户。撤销对后续请求生效；已经开始的请求不保证立即停止。

key 记录支持 enabled、rpm、concurrent、scopes（chat/responses）、expiresAt。当前 CLI 使用默认值；修改数据库前备份，并保留有效 JSON 和既有文件权限。直接编辑记录不需要重启。

## 历史归属

previous_response_id 只允许创建该历史的 key 使用。不同 key 请求该 ID 会返回 400。网关归属表和 Responses 缓存都在进程内，服务重启、缓存淘汰后需要新会话或重传完整 input。

这不代表模型永远记得全部历史，也不代表共享 AWS 账户的数据已完全租户隔离。

## 错误码

| 状态码 | 常见含义 |
| --- | --- |
| 400 | 参数/JSON 不支持、历史已丢失或不属于该 key |
| 401 | key 无效、过期、被撤销，或未携带 Bearer |
| 403 | key 的 scopes 不允许此接口；也可能是 HTTPS 入口的 WAF |
| 404/405 | 路径、模型名或方法错误 |
| 413 | 请求或提示上下文过大 |
| 429 | 每分钟、单 key 并发或总并发超限 |
| 502/503 | 上游登录、协议、网络或服务异常 |
| 504 | 请求超时 |

部分错误来自 Cloudflare 而不是 Node 服务。应同时检查 content-type、错误 JSON 来源和对应日志，不能把所有 502 都当作模型错误。
