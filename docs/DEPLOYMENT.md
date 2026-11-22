# VPS 与 HTTPS 部署

以下以 Ubuntu 24.04、Node.js 22+、systemd 和 `/opt/quick-api` 为例。安装器不改动已有 Nginx、Docker、Cloudflare DNS 或隧道路由。需要已有的 SSH 管理权限和自己的域名。

## 1. 准备运行目录

将仓库复制到 VPS 的 `/opt/quick-api`。安装 Node.js 官方受支持版本，确认 `node --version` 和 `npm --version` 正常。Node 的绝对路径应位于 /usr 或 /opt 等服务可访问的位置，不要依赖 root 的 NVM/home 目录。

```sh
cd /opt/quick-api/quick-proxy
npm ci --omit=dev --ignore-scripts
node import-session.mjs /secure/path/quick.har /secure/path/cookie.txt
```

在 VPS 导入时不传 Windows 的 localhost 出站代理。也可以将本机已导入的会话安全复制过来，但需要删除 session.local.json 中仅在本机有效的 outboundProxy。这一步会把 AWS 会话存到 VPS，VPS 应是你控制并信任的机器。

## 2. 安装 systemd 服务

```sh
cd /opt/quick-api
sudo python3 deploy/install.py --public-base-url https://api.example.com/quick/v1
```

安装器会：

- 检查 Node 版本和三份必要的内部配置文件。
- 安装 quick-proxy 的生产依赖，不运行第三方安装脚本。
- 创建低权限 quick-api 系统用户。
- 设置受限制的目录、配置权限和 `/opt/quick-api/state`。
- 安装并启用 quick-backend、quick-codex、quick-gateway 三个服务。
- 创建管理员命令 quick-key，用于生成和撤销用户密钥。

服务使用 NoNewPrivileges、PrivateTmp、ProtectHome、ProtectSystem=strict 和每服务 256 MiB 内存上限。上限不是实际内存占用；低内存 VPS 仍需观察自身业务和并发。

```sh
sudo systemctl status quick-backend quick-codex quick-gateway --no-pager
sudo quick-key create alice
sudo quick-key list
```

创建结果给出明文用户配置文件所在路径。管理员自行安全交付对应用户。不要将 AWS 会话和内部 key 一起交付。

## 3. Cloudflare Tunnel：已有域名增加 /quick

参考 deploy/cloudflared.example.yml。在现有 hostname 的无 path 兜底规则**之前**增加：

```yaml
- hostname: api.example.com
  path: ^/quick(/|$)
  service: http://127.0.0.1:8789
```

Cloudflare 会将完整路径传给网关，网关识别 /quick 前缀。保留原来的 SSH、网站、面板和最后的兜底规则。

修改前备份原配置，验证再重启：

```sh
sudo cloudflared --config /etc/cloudflared/config.yml tunnel ingress validate
sudo cloudflared --config /etc/cloudflared/config.yml tunnel ingress rule https://api.example.com/quick/v1/models
sudo systemctl restart cloudflared
```

重启 Cloudflare Tunnel 可能让已有网站、WebSocket 和经隧道建立的 SSH 暂时重连。若 SSH 本身依赖该隧道，应预先保留另一条管理通道或可恢复的后台部署方式。

## 4. 其他 HTTPS 入口

也可使用 deploy/Caddyfile.example。域名 DNS 指向服务器并满足证书签发要求后，HTTPS 入口反代回环 8789。不要同时让不同服务抢占现有 443 端口。

若 Nginx 已经承接域名，可新增精确的 /quick/ location；选择保留或去除 /quick 前缀中的一种，避免二次重写。流式需要关闭代理缓冲并提供足够长的读取超时。

## 5. 上线验收

1. 不带 key 的 /quick/v1/models 应返回 401。
2. 个人 key 能读取模型 quick，内部 key 不应作为公共 key 使用。
3. 分别验证普通聊天和 stream=true。
4. 验证 Responses，以及同 key 历史续接。
5. 用另一个 key 请求 previous_response_id，应被拒绝。
6. 撤销测试 key，后续请求应返回 401。
7. 检查已有网站、面板和 SSH 正常。

仓库提供 verify-public.mjs / verify-isolation.mjs，需在 quick-api-gateway 安装开发依赖后运行。这些脚本会真实调用 AWS 并创建测试会话。

## 升级和回滚

先备份当前代码及受保护的会话/密钥数据库，在新版本运行模拟测试，再部署。不要用 git clean 或覆盖式同步删除被忽略的运行文件。

```sh
sudo systemctl restart quick-backend quick-codex quick-gateway
sudo journalctl -u quick-gateway -n 50 --no-pager
```

重启会中断进行中的请求并清除历史缓存。回滚代码不等于回滚密钥撤销，应分别管理代码、AWS 会话和用户 key 数据库。
