# Compose、Nginx SSE 与 HTTPS/TLS

2026-11-24 已提供可运行编排与环境模板，采用现有 Quick 网关模块，而非另起不兼容的 Express 服务。生产仍由 systemd 和现有 Cloudflare Tunnel 提供服务；本次容器验证使用独立端口与临时证书，没有切换生产公网入口。

## 文件

```text
quick-api-gateway/
  Dockerfile
  .dockerignore
  .env.example
  compose.yml
  nginx/default.conf.template
```

Linux 主机使用 host 网络，网关访问已有的 127.0.0.1:8787/8788 Quick 服务；Nginx 再访问编排内的 127.0.0.1:18789 网关。默认 HTTP/HTTPS 分别为 18080/18443，均仅监听 127.0.0.1，便于与生产并存。此编排不包含 AWS 登录会话抓取、Quick 后端或桥接的独立部署，也不适用于 Windows Docker Desktop 的桥接网络。

## 环境与正式证书

```bash
cd /path/to/aws-quick-openai-gateway/quick-api-gateway
cp .env.example .env
id -u quick-api
id -g quick-api
```

按输出填写 .env 的 QUICK_SERVICE_UID/QUICK_SERVICE_GID，使网关能读取原配置。确认 QUICK_CLIENT_HOST_FILE 与 GATEWAY_STATE_HOST_DIR 是现有服务的真实路径。模板不包含实际 Key；空池配置会沿用现有内部 Key。

QUICK_TLS_DOMAIN 默认为 moyubooks.icu，可替换为自己的域名。TLS_CERT_DIR 必须是包含以下两个普通文件的目录：

- fullchain.pem：覆盖域名的正式证书链。
- privkey.pem：与证书对应的私钥，权限限制为部署用户可读。

将现有 CA/ACME 签发的证书文件复制到该目录，或设置 TLS_CERT_DIR 指向已有目录。不要把私钥提交到仓库或放入镜像。若使用 Let's Encrypt 的 live 目录，文件常为指向 archive 的符号链接；仅挂载 live 子目录会导致链接目标不可见，建议复制为部署目录下的普通 PEM 文件。

本次只生成了短期测试证书用于隔离验证，已随测试目录清理。未向 CA 申请生产证书，也未设置生产证书续期任务。已有 Cloudflare 公网 HTTPS 继续使用原入口。DNS-01 签发需要域名 DNS 授权，HTTP-01 则需要验证路径能到达签发程序；不能仅靠导入 API Key 获得证书。

## 启动和检查

```bash
docker compose --env-file .env config --quiet
docker compose --env-file .env up -d --build --wait
docker compose ps
docker compose exec -T nginx nginx -t
curl http://127.0.0.1:18080/healthz
```

正常业务 HTTP 请求返回 308 跳转到 QUICK_TLS_DOMAIN:QUICK_HTTPS_PORT，HTTPS 接口仍为 /v1/messages 或 /quick/v1/messages。证书文件缺失、路径错误或服务未健康时，编排不会伪装为可用。

HTTPS/SSE 验证（替换域名，API Key 从终端环境读取）：

```bash
curl --no-buffer \
  --resolve moyubooks.icu:18443:127.0.0.1 \
  https://moyubooks.icu:18443/v1/messages \
  -H "x-api-key: $QUICK_USER_API_KEY" \
  -H 'Content-Type: application/json' \
  --data '{"model":"quick","max_tokens":128,"stream":true,"messages":[{"role":"user","content":"Reply OK"}]}'
```

使用正式受信任证书时保持默认校验；私有 CA 则用 --cacert 指定 CA。验证脚本通过显式信任临时测试证书完成校验，没有使用跳过校验参数。

## 无缓冲和取消

Nginx 关闭 proxy_buffering、proxy_request_buffering、proxy_cache、gzip，并设置 no-store/no-transform 和 X-Accel-Buffering。proxy_next_upstream off 防止 Nginx 额外重放 POST；重试统一由网关 Key 池处理。HTTP/1.1 上游连接的 Connection 头清空，保留长连接。客户端关闭连接后，网关取消上游请求。

Nginx 请求体上限与网关一致为 4 MiB，连接超时 15 秒、读写超时 300 秒。REQUEST_TIMEOUT_MS 控制网关一次完整请求（包含全部 Key 尝试和完整流）的总时长，Compose 默认 180000 毫秒，直接运行默认 150000；它不改变 Quick 桥接自己的生成超时。SSE 等待心跳仍由桥接发送，生成结果须完整校验后才交付工具动作。

TLS 仅允许 1.2 和 1.3。模板变量使用 NGINX_ENVSUBST_FILTER 限定，避免把 $host、$request_uri 等 Nginx 变量错误替换为空。访问日志仅包含方法、路径（不含查询）、状态与耗时；不记录认证头或正文。

## 证书更新与入口切换

证书目录按目录只读挂载，便于主机续期后原子替换 PEM 文件。续期工具完成正式证书更新后，复制新证书链和匹配私钥到 TLS_CERT_DIR，再执行：

```bash
docker compose exec -T nginx nginx -t
docker compose exec -T nginx nginx -s reload
```

可将这两步加入已有 ACME 客户端的成功续期钩子；若 nginx -t 失败，先修复证书链或密钥匹配问题，保留当前运行进程。

需要公网直接接入 Nginx 时，设置实际域名证书、监听地址与所需端口后再安排入口切换。当前默认 loopback 监听适合现有 Tunnel 或本机验证。本次没有改 DNS、防火墙、生产 Tunnel 或已有公网端口。

## 实测

服务器实际运行 docker compose config、两服务健康检查和 nginx -t。HTTPS 证书校验、HTTP→HTTPS 跳转、Nginx→网关→Quick 的真实 Messages 流均已通过；完整收到 message_start、正文和 message_stop，首事件约 0.1 秒。测试编排和临时私钥已清理，正式运行实例不受影响。最新验收 JSON 记录实际结果。
