# cloudmusic-cf

Cloudflare Workers + PWA 版「云音乐」。导入 QQ 音乐 / 网易云歌单，或直接搜歌，点一下就在线播放。

项目提供**两套界面**，共用同一套后端接口与浏览器本地数据：

| 入口 | 用途 | 文件 |
|---|---|---|
| `/` | 桌面版，深色卡片式布局 | `index.html` / `app.js` / `style.css` |
| `/m` | 移动版，界面与交互参照安卓客户端，为 iPhone 网页播放设计 | `m.html` / `m.js` / `m.css` |

手机 UA（iPhone / iPad / Android 等）访问 `/` 会**自动跳转到移动版**；在移动版「设置 → 切换到桌面版」可豁免跳转（记在 `sessionStorage`）。PWA 的 `start_url` 也指向 `/m`。

> `/m` 是真实入口，`/m.html` 是同名静态文件 —— Cloudflare Workers Assets 默认会把 `.html` 307 重定向到无扩展名路径（`/m.html` → `/m`）。所以 PWA 的 `start_url` 用 `/m`，避免启动时多一次重定向。

> 音源策略与安卓客户端一致：夸克（下歌吧）优先，其次网易云、酷我；命中的试听片段只记下来继续找完整版，全是片段才兜底返回。三路音源是**并行**探的，不再一层层等。

---

## 功能

### 歌单与点歌（两套界面都有）
- **导入歌单**：粘贴 QQ 音乐 / 网易云歌单链接或纯数字 id，短链会跟随重定向；纯数字 id 可手选平台。
- **搜索点歌**：按歌名 / 歌手搜索，结果直接点播（不必先有歌单）。
- **我的歌单**：导入过的歌单都进「我的歌单」集合（桌面版首页卡片 / 移动版「歌单」Tab），点一下即可载入并播放该歌单全部歌曲。
- **我的收藏**：播放页点心形收藏，收藏列表可当歌单播放（移动版「我的」Tab 就是收藏页）。

### 播放器（两套界面都有）
- 底部迷你播放器显示当前歌曲与进度，点它进入全屏播放页。
- 全屏播放页：氛围渐变背景、封面页 ↔ 歌词页翻面、进度条、上下首、播放模式、收藏。
- **播放模式**：列表循环 / 随机 / 单曲循环（记忆到本地）。
- **定时关闭**：15 / 30 / 60 分钟，或播完本曲后停止。
- **播放列表（队列）**、**歌曲信息**弹窗。
- 歌词逐行高亮居中滚动、点歌词行跳转到那一句；**歌词时间校准**（±0.5 秒步进）、**手动搜索歌词**、**重新匹配歌词**。
- 上述定时关闭、队列、歌曲信息、歌词操作都在播放页 `✦` 更多菜单里。
- MediaSession：支持系统媒体键 / 锁屏信息（浏览器支持范围内）。

### 移动版专属（对齐安卓客户端）
- **底部 4 个 Tab**：我的（= 收藏）/ 歌单（= 我的歌单集合）/ 搜歌 / 设置，毛玻璃浮岛底栏。
- **「我的」= 收藏**：深色渐变 **MY FAVORITES** Hero 卡（收藏数 / 歌手数 / 专辑数）、吸顶搜索框、播放全部、默认 / 按标题 / 按歌手排序；收藏来自播放页的小红心。
- **「歌单」= 歌单集合**：上方导入卡片，下方「我的歌单」列表（封面 / 名称 / 平台 · 首数 · 本机或云端）；点列表项进入歌单详情页，看该歌单全部歌曲并可一键播放全部。
- 浮岛迷你播放器：旋转唱片封面、顶部进度线、歌名-歌手、播放 / 下一首 / 队列；**左右滑切歌**。
- 全屏播放页封面左上角来源角标、左下歌手、右下曲目序号；**左边缘右滑返回**。
- 每行歌曲的竖三点菜单：播放这首 / 收藏 / 歌曲信息。
- 独立的登录 / 欢迎页（可跳过）。
- 歌曲列表封面用 `IntersectionObserver` 按需懒加载，避免一次请求上百张图。

### 账号与云端歌单（两套界面都有）
- **不强制登录**：不登录照样能用，数据只存在本机 `localStorage`。
- **账号登录**：用管理员在后台创建的用户名 + 密码登录；移动版可在**登录页直接登录**，登录后进入主界面。
- **导入即同步**：登录状态下导入歌单，会自动存进 Cloudflare D1，不需要再手动点保存；未登录时只存本机，登录后自动补传。
- **歌单集合**：登录后自动把云端歌单拉回「我的歌单」列表；点列表项打开（云端歌单按需拉取曲目），删除会同时删掉云端那条。
- **夸克 Cookie 云端同步**：登录后本机 Cookie 会自动上传 D1（**AES-GCM 加密后存储**），换设备登录即可直接取回；扫码或手动换了新 Cookie 会覆盖云端旧值。两端同时存在时按「谁新用谁」自动取舍：比较**统一用服务端时间戳**（手机时钟不准不会误判），本机这份还没同步过就以本机为准。云端那份若已失效（别人换设备登过、Cookie 过期），会先验一次有效性，失效就保住本机这份并回写云端，不会把「明明登录了」的状态冲掉。
- **后台管理** `/admin.html`：管理员密码登录（默认 `admin888`，可用 `ADMIN_PASSWORD` secret 覆盖），可添加 / 删除用户、查看用户列表。
- **收藏云端同步**：登录后收藏（小红心）自动上云，换设备登录即可看到；多设备按 key 合并，云端被取消的收藏会同步删掉本机那条（软删除留墓碑，避免旧设备把歌「复活」）。没登录时收藏只存本机。
- 每个用户只能看到自己的歌单，删除用户会连带删掉其全部歌单。
- 密码用 **PBKDF2-SHA256 加盐**（10 万次迭代）存储，服务端不存明文；会话令牌用 **HMAC-SHA256** 签名（复用 `STREAM_SECRET`），30 天有效，存在浏览器本地。

### 界面与设置
- **主题**：跟随系统 / 浅色 / 深色。
- **在线歌词开关**：关闭后不请求歌词接口。
- **夸克扫码登录** + 手动粘贴 Cookie。
- 歌曲封面走「歌单元数据 → QQ 音乐 → iTunes US」来源链，严格匹配歌名歌手；查不到时画程序化占位图（渐变天空 + 圆日）。
- PWA：可「添加到主屏幕」独立运行，含 iOS 主屏图标、状态栏主题色、安全区适配与离线静态资源缓存（Service Worker 缓存版本 `cloudmusic-cf-v13`）。移动端「设置 → 应用 → 添加到主屏幕」一键调起安装：安卓 Chrome 直接弹安装框，其它浏览器提示去菜单选「添加到主屏幕 / 安装应用」；装好后从桌面图标打开全屏无地址栏，`start_url` 指向 `/m`。

### 移动端（iPhone）特别处理
- **音频手势解锁**：Safari 要求 `play()` 在用户手势的同步调用栈里，而本项目需要先异步解析音源。首次交互时用一段 0.05 秒静音 wav 解锁 `<audio>` 元素；若仍被拒绝，会弹出「点此开始播放」兜底。
- `playsinline` / `viewport-fit=cover` / `safe-area-inset` 适配刘海与 Home 条。
- 迷你播放器左右滑切歌。
- **安卓式返回栈**：每进一层（歌单详情 / 全屏播放页 / 弹层）压一条 `history`，安卓左边缘右滑、系统返回键、外接键盘 Esc 都按层级往回退，跟原生 App 一样——在播放页或详情页右滑是回上一页，只有在最外层才会退出应用。
- 登录页可跳过（只用公开音源试听），登录态记在本机，不会每次挡路。

---

## 本地运行

```bash
npm install
npm run dev          # 默认 http://localhost:8787（端口被占用会顺延）
npm run typecheck    # tsc --noEmit
```

开发期（`localhost` / `127.0.0.1`）**不注册 Service Worker** 并清掉旧注册，避免反复改页面却一直看到缓存的旧版本；生产域名才启用 PWA。

## 部署

```bash
wrangler login
wrangler secret put STREAM_SECRET     # 必做：一串长随机字符串
wrangler deploy
# 可选：把夸克 Cookie 放服务端，前端就不必填
wrangler secret put QUARK_COOKIE
# 可选：覆盖后台管理员密码（默认 admin888）
wrangler secret put ADMIN_PASSWORD
```

`wrangler.toml` 里的 `STREAM_SECRET = "dev-only-change-me"` **只是本地开发占位值**，它用来给直链令牌和登录态做 AES-GCM 加密，也用来签发账号会话令牌。部署前务必用上面的 `wrangler secret put` 覆盖：secret 优先级高于 `[vars]`，且不会写进仓库。仓库是公开的话尤其不要沿用默认值。

### 启用账号与云端歌单（D1）

账号和歌单存在 **Cloudflare D1**，首次部署按下面三步走：

```bash
# 1. 建库，把返回的 database_id 填进 wrangler.toml 的 [[d1_databases]]
wrangler d1 create cloudmusic-cf

# 2. 建表（users / playlists / user_settings / favorites）
wrangler d1 execute cloudmusic-cf --remote --file=schema.sql

# 3. 重新部署，让新绑定生效
wrangler deploy
```

`schema.sql` 全部是 `CREATE TABLE IF NOT EXISTS`，升级后重跑一次即可补上新增的表，不会动已有数据。

本地开发不用建远程库，`wrangler dev` 会自动用 `.wrangler/state` 下的本地 SQLite；本地建表跑一次 `wrangler d1 execute cloudmusic-cf --local --file=schema.sql` 即可。

建好后访问 `https://你的域名/admin.html`，用管理员密码（默认 `admin888`）登录，就能添加用户名和密码；然后用户在网页上用这组账号登录并同步歌单。**公网部署务必用 `wrangler secret put ADMIN_PASSWORD` 改掉默认密码。**

部署后先打开 `/api/health` 确认连通；要让 iPhone 能访问，需要是公网 HTTPS 地址（`localhost` 手机连不上）。

---

## 使用

1. 打开页面 → 「设置」→ 点**扫码登录夸克**，用夸克 App 扫屏幕上的二维码并确认；成功后 Cookie 自动填好并保存（跟安卓客户端一样，不用去翻浏览器 Cookie）。也可以手动粘贴完整 Cookie（需含 `__pus`）。不登录也能用，只是可能只有 30 秒试听片段。**已登录账号的话，Cookie 会同时加密存到云端**，换设备登录后自动取回；重新扫码拿到新 Cookie 会覆盖云端旧值。
2. 粘贴 QQ 音乐 / 网易云歌单链接（或纯数字 id，用下拉框选平台）→ 导入；或在「搜歌 / 搜索点歌」里直接搜一首。
3. 点歌名播放。首次解析会并行探几个音源（网易云 / 酷我同时跑，夸克在线时再加一路），状态栏和「解析过程」里能看到每一步。
4. 点底部迷你播放器进入全屏播放页看歌词；`✦` 打开更多菜单。
5. 手机上用浏览器「添加到主屏幕」当 PWA 用；同一台手机不便扫码时，二维码下方有「点这里直接打开夸克」的链接。
6. 扫码接口临时不可用时，仍可在设置里手动粘贴 Cookie 兜底（电脑浏览器 F12 → Network → 复制 Request Headers 里的整条 Cookie）。

### 夸克扫码登录原理

走夸克官方 CAS：`getTokenForQrcodeLogin` 取 token → 夸克 App 扫码 → `getServiceTicketByQrcodeToken` 拿 ticket → `pan.quark.cn/account/info?st=...` 手动跟随重定向、逐跳收集 `Set-Cookie`（含 `__pus`）。

Worker 无状态，登录过程的 `_UP_*` 会话 Cookie 和 token 用 AES-GCM 封进 `loginToken` 由前端带回，**不落服务端、不明文进 URL**，有效期 5 分钟。最终 Cookie 只存在浏览器 `localStorage`；播放链接里的上游地址和 Cookie 也用 AES-GCM 封进 2 小时短时效令牌，不会变成公开代理。二维码 SVG 由 Worker 本地生成，不依赖外部图片服务。

### 浏览器本地存储

| key | 内容 |
|---|---|
| `cm.playlist` | 当前歌单 / 播放队列 |
| `cm.plists` | 歌单集合（我的歌单）：已同步的只存元数据，曲目按需从云端拉 |
| `cm.cookie` | 夸克 Cookie |
| `cm.cookieAt` | 夸克 Cookie 保存时间戳（与云端比新旧用） |
| `cm.favs` | 收藏的歌曲（移动版「我的」页；登录后与云端合并） |
| `cm.playMode` / `cm.lyricOffset` | 播放模式 / 歌词偏移 |
| `cm.covers` | 封面地址缓存（含负缓存与同专辑复用，带时间戳） |
| `cm.lyric.*` / `cm.lyricKeys` | 歌词本机缓存（最多 300 首，索引在 `cm.lyricKeys`） |
| `cm.resolved` | 音源解析结果本机缓存（最多 80 首，直链令牌 80 分钟有效），切歌秒开 |
| `cm.onlineLyric` / `cm.theme` | 在线歌词开关 / 主题 |
| `cm.loggedIn` | 移动版是否已通过登录页 |
| `cm.account` | 账号登录态（会话令牌 + 用户名） |
| `cm.adminToken` | 后台管理令牌（仅 `/admin.html` 使用） |
| `cm.desktop`（sessionStorage） | 豁免手机自动跳转 |

清除本机数据：移动版「设置 → 清除本地数据」，或直接清站点数据。

---

## 目录结构

```
src/
  index.ts        Worker 入口，路由分发 + 静态资源
  playlist.ts     歌单导入（网易云 / QQ）、搜索点歌
  sources.ts      音源解析：夸克 → 网易云 → 酷我，三路并行探活 + 解析结果缓存
  quark.ts        夸克分享链接转直链
  quark-login.ts  扫码登录 CAS 流程
  lyric.ts        歌词：来源 id 直取 + QQ 搜索 + 下歌吧 + 酷狗 / 网易云兜底
  cover.ts        封面来源链：元数据 → QQ → iTunes US，含歌名清洗与严格匹配打分
  qr.ts           二维码 SVG 生成
  match.ts        歌名 / 歌手匹配
  util.ts         HTTP、AES-GCM 封印、Cookie 合并等工具
  types.ts        类型定义
  auth.ts         PBKDF2 密码哈希 + HMAC 会话令牌
  store.ts        D1 存储层：用户与歌单
public/
  index.html / app.js / style.css          桌面版
  m.html / m.js / m.css                   移动版
  admin.html / admin.js / admin.css       后台管理（添加 / 删除用户）
  sw.js                                   Service Worker
  manifest.webmanifest / icon*.png / icon.svg / apple-touch-icon.png
schema.sql        D1 建表语句（users / playlists）
wrangler.toml     Workers 配置
```

## API

所有接口都由同一个 Worker 提供，`GET /api/stream` 与 `GET /api/qr` 外均为 `POST` + JSON。

| 接口 | 请求 | 返回 |
|---|---|---|
| `GET /api/health` | — | `{ ok, time }`，连通性冒烟测试 |
| `POST /api/quark/login/start` | — | `{ loginToken, qrText, qrImage }` |
| `POST /api/quark/login/poll` | `{ loginToken }` | `{ status: waiting \| expired \| ok, cookie?, account?, debug? }` |
| `GET /api/qr?data=` | 二维码内容（≤1024 字符） | Worker 本地生成的 SVG |
| `POST /api/playlist` | `{ input, platform? }` | 歌单名、平台、曲目列表 |
| `POST /api/search` | `{ keyword }` | `{ tracks }`，可直接点播的曲目列表 |
| `POST /api/resolve` | `{ title, artist, durationSec, platformId?, cookie? }` | `{ ok, resolved?, notes, error? }`；`resolved` 含 `url` / `source` / `partial` / `fileName` |
| `POST /api/lyric` | `{ title, artist, platform?, platformId? }` | `{ lyric, source?, error? }`，LRC 文本 |
| `POST /api/cover` | `{ title, artist, album?, coverUrl? }` | `{ url, source, strict }`；`source` 为 `metadata` / `qq` / `itunes` / `loose` / `none` |
| `GET /api/cover-img?u=` | 封面原图地址（CDN 白名单） | 同源代理图片，供 canvas 取色与规避防盗链 |
| `GET /api/stream?t=` | 加密令牌 | 带 Cookie / Referer / UA 的流式代理，透传 Range |
| `POST /api/admin/login` | `{ password }` | `{ token }`，后台管理员令牌 |
| `GET /api/admin/users` | — | 用户列表（需管理员令牌） |
| `POST /api/admin/users` | `{ username, password }` | 创建用户（需管理员令牌），用户名重复返回 409 |
| `DELETE /api/admin/users/:id` | — | 删除用户及其全部歌单（需管理员令牌） |
| `POST /api/auth/login` | `{ username, password }` | `{ token, username }`，普通用户令牌 |
| `GET /api/me` | — | `{ id, username }`，当前登录用户（需用户令牌） |
| `GET /api/playlists` | — | 当前用户的云端歌单列表（含 `count` 首数） |
| `POST /api/playlists` | `{ name, platform, tracks }` | 新建云端歌单，返回 `{ id, name, platform }` |
| `GET /api/playlists/:id` | — | 歌单详情（含 `tracks` JSON） |
| `DELETE /api/playlists/:id` | — | 删除歌单 |
| `GET /api/settings/quark` | — | 云端夸克 Cookie：`{ hasCookie, cookie?, updatedAt }` |
| `POST /api/settings/quark` | `{ cookie }` | 保存（覆盖）云端夸克 Cookie，返回 `{ ok, updatedAt }`；传空串等于清除 |
| `POST /api/settings/quark/check` | `{ cookie }` | 验一份 Cookie 还能不能用：`{ valid: true/false/null }`（null = 判断不出） |
| `DELETE /api/settings/quark` | — | 清除云端夸克 Cookie |
| `GET /api/favorites` | — | 云端收藏列表：`[{ key, track, deleted, createdAt, updatedAt }]` |
| `POST /api/favorites` | `{ key, track }` | 收藏一首（幂等），重新收藏会清掉取消标记 |
| `DELETE /api/favorites/:key` | — | 取消收藏（软删除留墓碑，避免旧设备复活） |

需要登录的接口用请求头 `Authorization: Bearer <token>` 鉴权；管理员令牌与用户令牌权限隔离（管理员令牌访问用户接口返回 401，用户只能读写自己的歌单，越权读取返回 404）。

`/api/resolve` 的 Cookie 也可通过 `X-Quark-Cookie` 请求头或服务端 `QUARK_COOKIE` secret 提供。夸克 CDN 返回 412（Cookie / `__puus` 不匹配）时，流式代理会带上 `X-Cloudmusic-Error: quark-412`，提示前端去刷新登录态。

## 音源与歌词策略

- **音源**：夸克（下歌吧）→ 网易云 → 酷我。每条候选都先探活；按文件大小 / 时长判断是否为试听片段，是则记下来继续找完整版，全部只有片段才用第一个兜底。
- **歌词**（对齐安卓 `LyricsRepository`，宁缺毋滥，宁可没有也不要错配）：
  1. **歌单自带 id 直取**：QQ `fcg_query_lyric.fcg`、网易云 `/api/song/lyric` —— 最准，但网易云很多歌没版权拿不到。
  2. **QQ 音乐搜索**（在线主力）：`client_search_cp` 搜歌 → `fcg_query_lyric_new.fcg` 取歌词。网易云的公开搜索接口现在基本靠不住（搜「稻香 周杰伦」会返回《刀马旦》这种无关结果），QQ 反而准得多。
  3. **下歌吧**：详情接口 `so.liumingye.cn/api/music/{id}` 自带完整歌词，曲库比 QQ 全，冷门歌靠它。多数是**没有时间轴的纯文本**，前端按歌曲时长把每行均分成时间轴，照样能跟着歌滚，并标注「行距为估算」。
  4. **酷狗**、**网易云搜索**兜底。
  - 匹配口径与安卓一致：歌名先清洗（去括号 / `Live`/`伴奏`/`翻唱` 等版本尾巴 / 开头序号），再打分 —— 歌名完全相同 10 分、互相包含 6 分、公共片段 4 分；歌手完全相同 8 分、互相包含 5 分；**低于 10 分宁可不返回**。原曲名没写版本却搜到伴奏 / 翻唱 / Remix 的直接丢弃。
  - 关键词按命中率从高到低试：`歌名 版本标签 歌手` → `歌名 歌手` → `歌手 歌名` → `原始歌名 歌手` → `歌名` → `原始歌名`。
  - 歌词会缓存到本机 `localStorage`（最多 300 首），切歌回来不用再问服务器。
- **封面**（对齐安卓 `CoverRepository`，按出图速度命中即止）：
  1. **歌单/搜索元数据**：网易云 `album.picUrl`、QQ `album.mid` 拼 `y.gtimg.cn` 500×500 —— 零成本、最准，绝大多数歌到这步就结束。
  2. **持久化缓存**：命中结果存 `cm.covers` 30 天，「查过但没有」负缓存 7 天；**同专辑**（歌手 + 专辑）严格命中过的封面直接复用给同专辑其他歌。
  3. **QQ 音乐搜索**：`albummid` 拼封面，中文曲库大、响应快。
  4. **iTunes US 兜底**：只试前两个关键词（`country=CN` 对中文歌几乎全空，安卓也明确不查 CN）。
  5. **程序化占位画**：安卓 `GeneratedCover` 同款——按歌名哈希从 6 组调色板里选一组，画渐变天空 + 圆日 + 三层山影；列表小图和播放页大卡共用同一张画。

  匹配口径与安卓一致：歌名相同 10 分 / 包含 6 分，歌手相同 +8 / 包含 +5，≥10 为严格命中；6~9 分且歌手对得上先记为候选，所有来源落空才用，避免同名翻唱张冠李戴。关键词会先洗掉 `(Live)`、`(苏打绿版)` 这类括号后缀再试。
  真封面统一走 `/api/cover-img` 同源代理（CDN 白名单），浏览器 canvas 才能取色：播放页氛围底从封面位图提主色，黑白封面或取色失败时回落到歌名调色板——与安卓 `extractCoverPalette` 的回落行为一致。

---

## 切歌提速

点一首歌要等「解析音源」，这是全链路里最慢的一环（要搜源、探活、签发直链令牌）。切歌慢主要卡在这里，前后端各做了几件事：

**前端（`public/m.js`）**
- **界面先切**：点歌后标题 / 封面 / 歌词**立刻**换成新歌，源标签显示「正在解析音源…」，音频在后台解析好后自己接上 —— 不用盯着上一首等。
- **本机解析缓存** `cm.resolved`：解析过的歌记住直链（令牌 80 分钟），再点同一首**直接起播**（~20ms），不重新问服务器。
- **预取相邻两首**：当前歌开始播的时候，后台就把上一首 / 下一首的音源解析好；点「下一首」时几乎零等待。
- **连点只认最后一次**：解析请求带 token 竞态，快速连点时旧结果直接丢弃，不会出现「点了 B 却在播 A」。
- **区分 AbortError**：切歌时旧音频的 `play()` 会被打断并抛 `AbortError`，这属于正常现象，直接忽略（早前被当成「直链失效」而删缓存重解析，反而更慢）。

**服务端（`src/sources.ts`）**
- **三路音源并行**：夸克 / 网易云 / 酷我同时准备候选直链，谁先探到完整版就用谁；原来是一路不中才走下一路，等待时间层层叠加。
- **夸克候选并行**：下歌吧搜到的前 3 个候选同时签发直链 + 探活，不用一个不行再试下一个。
- **解析结果缓存**：Worker 实例内存缓存，TTL 10 分钟、上限 200 条；key 含歌名 / 歌手 / 平台 id / 时长 / Cookie 指纹，换 Cookie 自动失效。

实测（本地）：首次解析 ~0.9s，预取命中或本机缓存命中 ~0.02s。

### PWA 安装（添加到主屏幕）
安装入口用浏览器的 `beforeinstallprompt`，Chrome 这套 API 有几个坑，都做了兜底，装不上时不会再变成「点了没反应」：

- **Service Worker 必须「已激活」**，Chrome 才肯给安装框。所以 SW 安装时**只预缓存图标和 manifest**（又快又小），应用外壳放后台缓存、最多等 3 秒——网络慢的设备不会卡在 `installing` 状态而失去安装入口。
- SW 注册用 `updateViaCache: 'none'`，`sw.js` 永远不过 HTTP 缓存，免得拿旧 SW 去判定「可安装」。
- `prompt()` 事件只能用一次，而且用过 / 没有用户手势会抛 `InvalidStateError` / `NotAllowedError`。现在都捕获住并给出下一步动作（取消或报错后 → 点「重新检测安装状态」刷新页面 → 浏览器重新给入口 → 再点一次安装）。
- 提供「可安装性自检」：逐项检查 HTTPS / manifest / 图标 / SW 激活 / 页面是否被 SW 接管，卡在哪一步直接写在设置页和诊断信息里。
- `getInstalledRelatedApps` 能问出系统里到底装没装（manifest 里声明了 `related_applications`）；卸载后残留的「已安装」标记会自动作废。
- 实在给不了安装框时，只能走 Chrome 菜单 →「添加到主屏幕 / 安装应用」，设置页会明确提示。

---

## 已知限制

- 没有 DLNA 投屏、FLAC 转码、离线音乐缓存、后台常驻播放逻辑（这两项是安卓客户端专属，网页版不做）。
- `*.workers.dev` 在中国大陆可能访问不稳；部署后先开 `/api/health` 测连通性，必要时绑自定义域名。
- 夸克直链是会话绑定的：签发时刷新的 `__puus` 必须跟着这条直链走，否则 CDN 返回 412；Cookie 过期就重新扫码登录。
- iOS Safari 的自动播放策略较严格，已做静音解锁 + 「点此开始播放」兜底；后台 / 锁屏连续播放仍受系统与浏览器策略影响，建议真机验证。
- 没有歌单元数据的老歌单，封面靠 QQ / iTunes 在线检索，可能与原专辑封面不完全一致；入库后即缓存，不会重复查。
- 安卓的「网盘同目录封面图」「音频文件内嵌封面（ID3/FLAC）」两档是网盘播放器专属，网页版无对应数据来源，未实现。
- 搜索点歌目前只走网易云搜索；播放模式、歌词偏移、主题、收藏、封面结果都持久化在 `localStorage`，只有本会话内的并发去重表（`coverCache`）不落盘；收藏在登录后额外同步到 D1。
- 账号体系只有用户名 + 密码，没有邮箱找回 / 改密 / 验证码，也没有注册接口（用户必须由管理员在后台创建）；令牌存在浏览器本地，换设备需重新登录。
- 云端夸克 Cookie 用 `STREAM_SECRET` 做 AES-GCM 加密后存 D1：**一旦更换 `STREAM_SECRET`，库里已存的 Cookie 就解不开**，需要重新扫码登录一次。Cookie 等同于网盘登录凭据，务必用 `wrangler secret put ADMIN_PASSWORD` 之外的强 `STREAM_SECRET`，并只在自己的账号下使用。
- 后台 `/admin.html` 没有登录失败次数限制，公网部署请务必改掉默认管理员密码 `admin888`。
