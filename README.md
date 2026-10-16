# claude_cloud-ce

> **声明:本项目与 Anthropic 及其旗下产品没有任何关联**,未经 Anthropic 授权或背书。项目不分发任何 Anthropic 版权二进制(官方 App 以补丁脚本形式提供,由使用者自行操作);推理流量全部转发到部署方自行配置的第三方上游,不经过 Anthropic 的服务器。

和 Anthropic 一样把 **Remote Control** 跑在**你自己的服务器**上:自建 OAuth / 登录、cc 与 web 两侧按账户隔离、自带 Web 控制台,模型用**第三方 API**,一条推理都不到 Anthropic。除此之外,这套服务端还能让**官方 Claude Android App 直连**,支持多账号注册/登录/封禁,可选配置推送通知。

## 架构

```
   浏览器 (controller)        cc 机器 (worker)              官方 Android App
      │ 登录拿 web token          │ HTTPS_PROXY=              │ 改 host(repack-app.sh)
      │ Authorization: Bearer     │   http://<worker-key>@…   │ 直连服务器 443,或改 host
      ▼                           │ CONNECT api.anthropic.com │ 指向同一台服务器走代理
 ┌──────────────────── claude_cloud-ce / app.mjs ─────────────────────────────┐
 │  Web 控制台 :8890        │  CONNECT 代理 :8898       │  App 直连 TLS :443    │
 │  · /auth/*  注册/登录     │  · worker-key → user      │  · 终结 TLS → 同一个  │
 │  · /api/sessions 只看     │    → 该连接打 _ccUser     │    httpSrv(core)      │
 │     自己 user 的会话      │  · api.anthropic.com      │  · App 消费侧账号体系 │
 │  · /admin/accounts*      │    终结;其它透传           │    (见下)独立于左边    │
 │    curl 控制封禁/unban   │                            │                       │
 └──────────┬───────────────────────────┬────────────────────────┬─────────────┘
            │ core (RC v2)              │ /v1/messages           │ /api/organizations/…
            │ session.userId 归属        ▼                        │ app_start / 多账号
            │ 跨 user 一律 404     第三方端点(推理)                ▼
            │                                              accounts.mjs(email+验证码)
```

**⚠️两套完全独立的身份系统**,这是最容易让人困惑的一点:
- **Web 控制台 / cc worker**:`users.mjs` 的 `Identity`,username+password 登录,worker 身份来自 `Proxy-Authorization`(`HTTPS_PROXY` 凭据位里的 worker-key),两者都解析到同一 `userId`;RC 会话归属 `userId`,跨 user 的读写一律 404。
- **官方 Android App**:`accounts.mjs` 的 `AccountStore`,email+邮箱验证码登录,每个账号有专属 `org_uuid`(App 登录后记下这个值,后续请求路径里带着它,服务端据此识别账号——不需要额外的 Cookie/Header 校验机制),可以被 admin 接口封禁/解封。

这两套体系互不相通,App 账号和 Web/worker 账号是两回事。

## 目录

```
claude_cloud-ce/
├── server/
│   ├── app.mjs       入口:CONNECT 代理 + App 直连 TLS + Web 控制台(三个监听口)
│   ├── proxy.mjs      备用入口("C 形态",只有 CONNECT 代理 + 回环控制面,无 Web/身份)
│   ├── config.mjs     统一配置加载(env > config/config.json > 独立 token 文件 > 默认值)
│   ├── core.mjs        API 核心(RC 端点 / 策略 / 开关 / 推理反代 / App 消费侧协议模拟)
│   ├── rc.mjs          RC v2 会话服务(帧信封 + worker 下行 SSE + web 实时 SSE)
│   ├── users.mjs       Web/worker 身份(scrypt 密码,落盘 config/users.json)
│   ├── accounts.mjs    App 消费侧多账号(email+验证码,专属 org_uuid,封禁状态,落盘 config/accounts.json)
│   ├── mail.mjs        零依赖 SMTPS 发信(登录验证码邮件)
│   └── fcm.mjs         FCM v1 推送(可选功能,见 docs/fcm-setup.md)
├── web/                Web 控制台构建产物(React + assistant-ui,源码在 web-src/)
├── config/
│   ├── config.example.json   配置模板,复制成 config.json 按需填写
│   └── (运行时产物:证书/token/users.json/accounts.json,全部 .gitignore)
├── scripts/
│   ├── gen-ca.sh       生成自签 CA + 叶子证书
│   ├── start.sh        幂等启动(含健康检查)
│   └── stop.sh         停止
├── client/
│   ├── worker.sh       cc worker 一键接入
│   ├── connect.sh      cc 客户端接入(Remote Control 会话)
│   └── repack-app.sh   给官方 Android App 打补丁,见 docs/repack-app.md
├── docs/
│   ├── repack-app.md   怎么给官方 App 打补丁、连你的服务器
│   └── fcm-setup.md    怎么配置可选的推送通知
└── features.json       下发给 App 的 GrowthBook 风格特性开关(协议数据,一般不用改)
```

## 服务端部署

**零依赖纯 Node**(只用 `http`/`net`/`tls`/`fs`/`crypto`),`node >= 18`,不需要 `npm install`。

```bash
scripts/gen-ca.sh [你的域名]                       # 1. 证书(有真域名就签进去)
cp config/config.example.json config/config.json   # 2. 复制配置模板
# 编辑 config/config.json,至少填 upstreamBase(必填)
scripts/start.sh                                    # 3. 起服务(幂等,已在跑会提示退出)
```

也可以完全用环境变量,不碰 `config.json`(两种方式可以混用,环境变量优先级更高):
```bash
UPSTREAM_BASE=https://你的第三方端点 scripts/start.sh
```

<!-- MORE -->

### 环境变量 / 配置字段完整表

每个字段都能用环境变量覆盖(优先级最高),或者写进 `config/config.json`(参考 `config.example.json`):

| 环境变量 | `config.json` 字段 | 默认值 | 必填 | 说明 |
|---|---|---|---|---|
| `UPSTREAM_BASE` | `upstreamBase` | — | **是** | 推理反代目标;没配置启动即报错退出(不会悄悄用错误的默认值) |
| `CC_UPSTREAM_TOKEN` | `upstreamToken` | — | 否 | 第三方凭据;也可以写进 `config/upstream.token`(0600) |
| `CC_BIND` | `bind` | `0.0.0.0` | 否 | 监听地址 |
| `CC_PROXY_PORT` | `proxyPort` | `8898` | 否 | worker CONNECT 代理端口 |
| `CC_WEB_PORT` | `webPort` | `8890` | 否 | Web 控制台 + 身份/会话 API + admin 端点 |
| `CC_APP_PORT` | `appPort` | `443` | 否 | 官方 App 直连 TLS 端口;`<=0` 则不开这个监听 |
| `CC_CTL_BIND` / `CC_CTL_PORT` | `ctlBind` / `ctlPort` | `127.0.0.1` / `9999` | 否 | 仅 `proxy.mjs`("C 形态")的简化控制面 |
| `CC_ADMIN_SECRET` | `adminSecret` | **首次启动自动生成**,写回 `config/admin.token` | 否 | `/admin/accounts*` 封禁接口的鉴权密钥;启动日志会打印一次 |
| `CC_FCM_SA` | `fcmServiceAccountPath` | `~/.config/cc-cloud/firebase-adminsdk.json`(不存在则推送功能静默禁用) | 否 | 见 [`docs/fcm-setup.md`](docs/fcm-setup.md) |
| — | `smtp` | `null`(验证码只记日志) | 否 | 也可以写 `config/smtp.json`;字段 `host/port/user/pass/from/fromName` |
| `CC_CONFIG` | — | `<仓库根>/config` | 否 | 配置文件目录本身的位置 |
| `CC_DATA_DIR` | — | `~/.config/cc-cloud` | 否 | 会话/项目/文件/推送 token 等业务数据落盘位置(不是"配置",是运行时数据) |
| `CC_LOG` | `log` | `app.log` / `proxy.log` | 否 | 日志文件路径 |
| `CC_QUIET` | `quiet` | `false` | 否 | 关掉日志的终端回显,只写文件 |

## Web 控制台 + cc worker

1. 浏览器打开 `http://服务器:8890`,**注册 / 登录**(自建账户,与 Anthropic 无关)。
2. 右上「**+ cc 设备**」生成一条 worker 接入命令(内含绑定你账户的 worker-key)。
3. 在要托管的机器上跑,或直接用那条命令:
   ```bash
   CC_SERVER=服务器 CC_KEY=wkr_xxx CC_CA=/路径/ca.pem client/worker.sh
   ```
   服务器用公网真域名证书时免 `CC_CA`。
4. 回浏览器,左侧出现该会话 —— 点进去看消息流、发消息,实时更新。别的账户看不到它。

`worker.sh` 启动 cc 时补三个身份变量:`CLAUDE_CODE_OAUTH_TOKEN=ssh-placeholder`(鉴权源切到代理)、`CLAUDE_CODE_OAUTH_SCOPES`(补 `user:profile`,否则报 "requires a full-scope login token")、`CLAUDE_CODE_SUBSCRIPTION_TYPE=pro`(过订阅门)。

## Android App 直连

官方 Claude App 硬编码连 `api.anthropic.com`,要让它连你的服务器,需要给 APK 打个补丁——我们不分发改过的官方二进制(版权问题),只分发怎么打补丁的脚本:

```bash
client/repack-app.sh 你自己下载的Claude.apks cc.example.com ./out
adb install-multiple ./out/*.apk
```

详细步骤、可选的推送通知/自签证书信任配置、已知问题,见 [`docs/repack-app.md`](docs/repack-app.md)。

打好补丁的 App 可以直连 `CC_APP_PORT`(默认 443),也可以像 cc worker 一样走 `CC_PROXY_PORT` 代理——取决于你改 host 时指向的是哪个端口。

## 多账号与封禁

官方 App 这一侧是独立的多账号体系(`accounts.mjs`),每个账号用 email + 邮箱验证码登录,各自有专属的会话/组织标识。用 curl 控制封禁:

```bash
ADMIN=$(cat config/admin.token)   # 或你在 config.json/CC_ADMIN_SECRET 里设的值
WEB=http://127.0.0.1:8890

# 创建账号(幂等,email 已存在则返回现有记录)
curl -X POST "$WEB/admin/accounts" -H "Authorization: Bearer $ADMIN" \
  -d '{"email":"someone@example.com","full_name":"Someone"}'

# 列表(?banned=true 只看被封的)
curl "$WEB/admin/accounts" -H "Authorization: Bearer $ADMIN"

# 封禁 / 解封(ref 可以是 email 或账号 uuid)
curl -X POST "$WEB/admin/accounts/someone@example.com/ban" -H "Authorization: Bearer $ADMIN" -d '{"reason":"..."}'
curl -X POST "$WEB/admin/accounts/someone@example.com/unban" -H "Authorization: Bearer $ADMIN"
```

封禁是全局生效的(不只挡登录,所有需要身份的请求都会被拦截),因为推理用的第三方凭据是全账号共享的一份,只挡登录挡不住已登录账号继续消耗配额。

## 邮件发信

App 的登录验证码默认会发邮件(`server/mail.mjs`,零依赖 SMTPS 实现)。不配置 SMTP 也完全能用——验证码会原文记进 `app.log`,自己看日志登录,单人自用场景足够。要配置真发邮件,填 `config/config.json` 的 `smtp` 字段(或 `config/smtp.json`):`host`/`port`/`user`/`pass`/`from`/`fromName`。

## 推送通知(可选)

官方 App 完成一轮回复后可以收到后台推送——这个功能完全可选,需要你自己申请一个 Firebase 项目(不能用别人的),配置步骤见 [`docs/fcm-setup.md`](docs/fcm-setup.md)。

## API

身份(无需 token,Web 控制台一侧):

| 方法 | 路径 | 作用 |
|---|---|---|
| `POST` | `/auth/register` `{username,password}` | 注册 → `{token, user}` |
| `POST` | `/auth/login` `{username,password}` | 登录 → `{token, user}` |

需登录(`Authorization: Bearer <token>`):

| 方法 | 路径 | 作用 |
|---|---|---|
| `GET`  | `/auth/me` | 当前账户 |
| `GET`/`POST` | `/api/worker-keys` | 列出 / 新建 worker key |
| `GET`  | `/api/sessions` | 自己的会话 |
| `GET`  | `/api/sessions/{id}/stream?after=N` | SSE 实时事件流 |
| `GET`  | `/api/sessions/{id}/events?after=N` | 拉历史事件 |
| `POST` | `/api/sessions/{id}/prompt` `{text}` | 注入用户消息 |
| `POST` | `/api/sessions/{id}/request` `{subtype,…}` | 下发 control 并等应答 |

管理员(`Authorization: Bearer <admin secret>`):见上方"多账号与封禁"。

官方 App 消费侧还有一整套协议模拟端点(`/api/organizations/{org}/...`、`/api/bootstrap/{org}/app_start`、`/v1/code/sessions*` 等),这些是逆向官方协议得到的,数量多、随 App 版本变化,不在这里逐条列文档——`core.mjs` 里每个端点都带着来源注释,想了解具体契约直接看源码。

## ⚠ 安全

- **CONNECT 代理虽有 worker-key 鉴权,绑 `0.0.0.0` 仍建议**配合防火墙/SSH 隧道收口;对非 `api.anthropic.com` 的透传不鉴权(给 cc 自更新/npm 用),别暴露到不可信网络。
- Web 控制台与 worker key 都走明文时,务必加 TLS(真域名证书)或只在局域网/VPN 内用。worker key 等于账户内的会话控制权。
- 密码用 scrypt 加盐哈希;`config/`(证书、token、users.json、accounts.json)已 `.gitignore`,不进库。
- **admin secret 没配置会自动生成**并写进 `config/admin.token`(0600),启动日志打印一次——如果你想用固定值,提前在 `config.json` 里填好或 `export CC_ADMIN_SECRET`。
- **FCM 服务账号 JSON 含私钥**,只应该存在于你自己服务器的磁盘上,绝不能提交进任何仓库、不能公开分享。

## RC v2 协议背景

RC v2 **不走 WebSocket**,全是 `api.anthropic.com` 上的 HTTP + SSE(`bridge.claudeusercontent.com` 那条 WS 是 "Claude in Chrome" 扩展的桥接,与 Remote Control 无关)。零第三方依赖、可直接复制,与同作者的 cc-link 一脉相承。

## 部署前检查清单

- [ ] `scripts/gen-ca.sh [你的域名]` 生成证书(有真域名就带上)
- [ ] `cp config/config.example.json config/config.json`,至少填 `upstreamBase`
- [ ] `scripts/start.sh` 起服务,看日志确认三个端口都监听了
- [ ] 浏览器打开 `:8890` 注册一个 Web 账户,确认控制台能用
- [ ] (可选)配 `smtp` 让验证码真发邮件
- [ ] (可选)配 `fcmServiceAccountPath`,见 `docs/fcm-setup.md`
- [ ] (官方 App 场景)`client/repack-app.sh` 打补丁装机,见 `docs/repack-app.md`
- [ ] 记下 `config/admin.token` 的值,留着 curl 控制封禁用
