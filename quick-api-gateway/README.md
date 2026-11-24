# Quick 网关模块

这是现有 Quick 服务的网关，需主机已运行 Quick 后端（8787）和 Claude 桥接（8788）。支持用户 Key 鉴权、权限/限流、独立上游凭据池、SSE、健康接口，以及可选 Docker/Compose/Nginx TLS 前端。

- [Key 池与 Node/Docker 启动](../docs/UPSTREAM-KEY-POOL.md)
- [Compose、HTTPS 和环境变量](../docs/COMPOSE-TLS.md)
- [.env 模板](.env.example)
- [上游池文件格式](upstream-keys.example.json)

先复制 .env.example 为本地 .env，填写主机配置路径、服务用户 UID/GID、域名和正式证书目录，再执行 `docker compose config --quiet` 与 `docker compose up -d --build --wait`。默认使用独立 loopback 端口，生产服务不会因此自动切换。

Node 运行模块仅依赖内置库。网关模块测试可用 `node --test gateway.test.mjs upstream-pool.test.mjs`；完整项目测试在上一级执行 `npm test`。

当前生产只有一组有效上游凭据。两个以上 Key 需要目标后端实际接受，用户分发 Key 不等于上游 Key；多 AWS 会话路由不在本模块范围内。
