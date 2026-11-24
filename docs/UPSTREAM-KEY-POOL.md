# 上游 Key 池、模块化与 Docker

前置 Nginx、HTTPS/TLS、Compose 和 .env 模板另见 [Compose 与 TLS](COMPOSE-TLS.md)。

2026-11-24：网关已加入独立的上游凭据池，保持现有鉴权、提示词优化和 SSE 链路。生产继续使用原有效内部 Key，当前只有一组实际有效上游凭据。没有创建额外 AWS 会话，也没有把分发给用户的 Key 当作上游 Key。

## 与示例的对应关系

```text
quick-api-gateway/
  config.mjs                  环境变量和私有 Key 池配置
  upstream-pool.mjs           轮询、冷却、有限重试、响应释放
  gateway.mjs                 HTTP 路由、用户鉴权、流转发、脱敏元数据日志
  keys.mjs                    用户 Key 的签发、scope、限流与撤销
  upstream-pool.test.mjs       Key 池与配置测试
  gateway.test.mjs             鉴权、SSE、重试与用户隔离测试
  upstream-keys.example.json   占位配置，不包含真实 Key
  Dockerfile
  .dockerignore
bridge/
  prompt-optimizer.mjs         已验证的请求体四项精简
  anthropic.mjs                Messages 与工具协议
  adapter.mjs                  会话、完整动作校验与等待心跳
```

沿用 ESM 和 Node 内置 HTTP/fetch；运行网关无需新增 Express 依赖。日志仅使用序号 upstream-1、尝试次数、状态码、用户记录 ID 和已知路由，不输出 Key 前后缀、请求头、查询参数或正文。

## 轮询与重试

- 每个新请求轮换起始 Key，单次请求中的每个 Key 最多尝试一次，候选顺序在请求开始时固定，避免并发推进游标导致重复尝试。
- 仅对上游 HTTP 401、403、429，在向客户端转发响应头之前切换。客户端鉴权失败、scope 不足和网关自身限流在此之前直接返回，不会通过轮询规避。
- 默认最多 4 次尝试，且不超过不同可用 Key 数量；一次总超时覆盖所有尝试及完整响应流，不按 Key 重置。
- 401/403 默认冷却 60 秒，429 默认 10 秒；参考 Retry-After 秒数或日期，冷却最长 300 秒。全部冷却时返回 503 和 Retry-After。最后一次上游错误仍直接转发，不丢失其状态码。
- 切换前取消被拒绝响应的 body，释放连接。网络异常、400/422/5xx 不自动重放；SSE 的 HTTP 200 内含 error 事件也不触发换 Key。流已开始后保持同一响应，不重放工具动作或伪造成功结束。
- Key 池轮询及冷却为进程内状态；多实例不共享冷却状态，重启后重新开始。

## 凭据与会话边界

当前请求目标仍是固定的本机 Quick 后端（8787）和桥接（8788）。改变认证 Key 不改变目标 URL，也不改变网关验证得到的用户 principal，因此保留该后端的历史归属与会话复用。

池中的每个 Key 都必须被这些目标接受，并具有相同用途与所需授权。当前 Quick 后端/桥接各自只配置一个内部 Key，不能仅在池中添加任意字符串就得到多个有效通道。用户分发 Key、AWS Cookie、不同供应商 Key 不能混用。多个 Key 指向同一 AWS 登录会话也不会增加 AWS 账户额度或并发上限。

此版本不是多 AWS 账户、多目标 URL 的路由器。真正切换独立 AWS 会话需要部署相应后端并实现会话粘性；不能简单轮换 Key 后把旧的增量会话发往另一个账户。AWS Cookie 续期仍由已有续期服务处理，网页 1011 错误也不会因轮询内部 Key 自动消失。

## 配置与直接启动

默认不增加配置，自动沿用 QUICK_CLIENT_FILE 中的原 apiKey。增加受目标接受的上游 Key 时，推荐使用权限受限的私有文件，内容格式参照 upstream-keys.example.json：

```text
GATEWAY_UPSTREAM_KEYS_FILE=/absolute/path/upstream-keys.local.json
UPSTREAM_MAX_ATTEMPTS=4
RETRY_STATUS_CODES=401,403,429
UPSTREAM_KEY_HEADER=authorization
REQUEST_TIMEOUT_MS=150000
```

也支持 UPSTREAM_API_KEYS 逗号列表；该变量与私有文件配置不可同时使用。缺少显式池配置时只回退原内部 Key，绝不会转发调用者 Key 作为内部认证。authorization 是本项目默认值；x-api-key 仅适合所有目标路由均支持该头的后端，当前 Quick 的 Chat/Models 不适合改成该值。

直接启动（在项目根目录，保留原配置路径）：

```bash
QUICK_CLIENT_FILE=/opt/quick-api/quick-proxy/client.local.json \
GATEWAY_KEYS_FILE=/opt/quick-api/state/keys.local.json \
GATEWAY_PORT=18789 \
node quick-api-gateway/gateway.mjs
```

端口示例使用 18789，以便与生产 8789 并存。要替代生产进程需按已有部署方式停止旧网关并使用相同端口；不要在相同端口同时启动两套。修改配置后重启 quick-gateway。/healthz 返回进程状态和池数量，不验证 AWS 登录或每个 Key 的有效性；业务验证仍使用已授权用户 Key 调用 /v1/models 与 /v1/messages。

## Docker

Dockerfile 采用 Node 22，与项目 engines 保持一致；只复制四个运行模块，.dockerignore 使用允许列表，真实凭据不进入构建上下文或镜像。默认非 root 用户。它只运行网关，Quick 后端与桥接仍由已有服务提供。

Linux 上使用 host 网络访问现有 loopback 后端；这不是 Docker Desktop 的桥接网络示例。服务仍绑定 127.0.0.1，由原 Cloudflare Tunnel 提供公网入口。

```bash
docker build -t quick-api-gateway:keypool quick-api-gateway

docker run -d --name quick-gateway-check \
  --network host --read-only --cap-drop ALL \
  --security-opt no-new-privileges \
  --user "$(id -u quick-api):$(id -g quick-api)" \
  -e GATEWAY_PORT=18789 \
  -e QUICK_CLIENT_FILE=/run/secrets/internal-client.json \
  -e GATEWAY_KEYS_FILE=/run/gateway-state/keys.local.json \
  --mount type=bind,src=/opt/quick-api/quick-proxy/client.local.json,dst=/run/secrets/internal-client.json,readonly \
  --mount type=bind,src=/opt/quick-api/state,dst=/run/gateway-state,readonly \
  quick-api-gateway:keypool

curl http://127.0.0.1:18789/healthz
```

按现有服务身份运行容器，需确保其能读取挂载配置。用户 Key 存储挂载目录，允许主机通过原子替换更新/撤销 Key 后在容器内读到新文件。若使用额外池文件，再只读挂载到 /run/secrets/upstream-pool.json，并设置 GATEWAY_UPSTREAM_KEYS_FILE 指向该路径。不要把 Key 写入 Dockerfile 或构建参数。

生产此次继续运行 systemd 网关；Docker 作为独立验证和可选启动方式，没有替换现有服务。

## 验证记录

58 项本地回归通过。包括模拟多个有效 Key 的轮询、并发候选不重复、401/403/429 切换、冷却、被拒绝响应释放、全池不可用、日志不含凭据、流内错误不重放、客户端断开、总超时、鉴权和跨用户历史隔离。实际服务器部署、Docker 构建及隔离容器验证结果见本次交付 JSON；隔离测试用“故意无效的测试 Key + 当前真实有效内部 Key”，不能将其描述为两组真实上游容量。
