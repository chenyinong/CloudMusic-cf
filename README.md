# cloudmusic-cf

Cloudflare Workers + PWA 版「云音乐」：导入 QQ 音乐 / 网易云歌单，点歌在线播放。
音源策略与安卓客户端一致：夸克（下歌吧）优先，其次网易云、酷我；命中试听片段会继续找完整版。

## 本地运行

```bash
npm install
npm run dev          # 默认 http://localhost:8787
npm run typecheck    # 类型检查
```

## 部署

```bash
wrangler login
wrangler secret put STREAM_SECRET     # 随便一串长随机字符串
wrangler deploy
# 可选：把夸克 Cookie 放服务端，前端就不必填
wrangler secret put QUARK_COOKIE
```

## 使用

1. 打开页面 →「设置」→ 点**扫码登录夸克**，用夸克 App 扫屏幕上的二维码并确认；成功后 Cookie 自动填好并保存（跟安卓客户端一样，不用去翻浏览器 Cookie）。
2. 粘贴 QQ 音乐 / 网易云歌单链接（或纯数字 id，用下拉框选平台）→ 导入。
3. 点歌名播放。首次会串行查几个音源，状态栏和「解析过程」里能看到每一步。
4. 手机上可用浏览器「添加到主屏幕」当 PWA 用；同一台手机不便扫码时，二维码下方有「点这里直接打开夸克」的链接。
5. 扫码接口临时不可用时，仍可在设置里手动粘贴 Cookie 兜底（电脑浏览器 F12 → Network → 复制 Request Headers 里的整条 Cookie，需含 `__pus`）。

扫码登录走夸克官方 CAS：`getTokenForQrcodeLogin` 取 token → 夸克 App 扫码 → `getServiceTicketByQrcodeToken` 拿 ticket → `pan.quark.cn/account/info?st=...` 跟重定向逐跳收集 `Set-Cookie`（含 `__pus`）。Worker 无状态，登录过程的 `_UP_*` 会话 Cookie 用 AES-GCM 封进 `loginToken` 由前端带回，**不落服务端、不明文进 URL**。最终 Cookie 只存在浏览器 localStorage；播放链接里的上游地址和 Cookie 也用 AES-GCM 封进短时效令牌，不会变成公开代理。

## API

| 接口 | 说明 |
|---|---|
| `GET /api/health` | 连通性冒烟测试 |
| `POST /api/quark/login/start` | 取夸克扫码登录二维码，返回 `qrText` / `qrImage` / 加密的 `loginToken` |
| `POST /api/quark/login/poll` | `{ loginToken }` → `waiting` / `expired` / `ok`（含 Cookie 与昵称） |
| `GET /api/qr?data=` | Worker 本地生成的二维码 SVG，不依赖外部图片服务 |
| `POST /api/playlist` | `{ input, platform? }` → 歌单与曲目列表 |
| `POST /api/resolve` | `{ title, artist, durationSec, platformId?, cookie? }` → 可播地址、音源、是否片段、解析日志 |
| `GET /api/stream?t=` | 带 Cookie/Referer/UA 的流式代理，透传 Range |

## 已知限制

- 没有 DLNA 投屏、FLAC 转码、离线缓存、后台常驻逻辑。
- `*.workers.dev` 在中国大陆可能访问不稳；部署后先开 `/api/health` 测连通性，必要时绑自定义域名。
- 夸克直链是会话绑定的：签发时刷新的 `__puus` 必须跟着这条直链走，否则 CDN 返回 412；Cookie 过期就重新扫码登录。
