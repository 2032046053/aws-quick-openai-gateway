# AWS 登录过期与切换账号

这两种情况都需要替换后端使用的 AWS 会话；公网用户的 API key 不用改变。

## 获取新会话

1. 浏览器登录目标 AWS Quick 账号。
2. F12 打开 Network，清空旧记录，刷新页面。
3. 发送一条最小测试消息并确认网页收到回复。
4. 找到此次 ChatBidirectionalStream WebSocket，请求 URL 中应包含目标 awsAccountId 和 mbtc。
5. 导出本次 HAR，将该连接的完整 Cookie 头值另外存成单行 cookie.txt。

不要混用两个账号或两次登录的 HAR/Cookie。导出 sanitized HAR 通常不包含完整 Cookie，因此需要单独的 Cookie 文件。HAR 仍可能含消息正文和认证相关参数，不能公开。

## Windows 一条命令同步到 VPS

安装器的 VPS 目录布局为 /opt/quick-api，SSH 别名自行配置：

```powershell
cd quick-api-gateway
.\Sync-Session.ps1 -SshHost your-vps -HarFile 'C:\path\quick.har' -CookieFile 'C:\path\cookie.txt'
```

脚本将：

- 在本机解析输入，仅提取账户、Cookie、CSRF，不更改内部 API key。
- 安全上传到指定 VPS，并用新会话请求一次真实 Quick。
- 只有返回预期的 SESSION_CHECK_OK 后才备份和替换活跃会话。
- 重启三个服务，清空 Responses 缓存，检查服务状态。
- 激活失败时尝试恢复之前的会话；删除上传的临时文件。

更新会中断正在进行的请求。调用者随后需要新开会话或重传完整历史。若原会话已失效，恢复备份只能恢复原状态，不能使过期登录重新有效。

`-ValidateOnly` 仅检查文件格式，不请求 AWS、不改动 VPS。不要把格式验证成功当作登录成功。

## 手动更新

在 VPS 后端目录执行 import-session.mjs。已有 .env 时它保留内部 key：

```sh
cd /opt/quick-api/quick-proxy
node import-session.mjs /secure/path/new.har /secure/path/new-cookie.txt
```

恢复 session.local.json 为 root:quick-api、640 权限，再重启 quick-backend、quick-codex、quick-gateway。不要复制 Windows 上的 localhost 代理配置到 VPS。

## 当前没有的功能

没有 AWS 自动登录、浏览器后台续登、Cookie 自动刷新、账号池轮换或失败自动切号。登录过期时需要自己重新认证。不同 AWS 账号的权限、区域和 Agent 配置可能不同，切换后应重新验证预期业务。
