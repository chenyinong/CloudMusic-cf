import type { Env, ResolveRequest, StreamPayload } from './types'
import { fetchPlaylist, resolveRef, searchTracks } from './playlist'
import { pollLogin, startLogin } from './quark-login'
import { verifyQuarkCookie } from './quark'
import { fetchCover } from './cover'
import { qrSvg } from './qr'
import { resolveTrack } from './sources'
import { fetchLyric } from './lyric'
import { http, json, unseal, withCors, UA_PC, seal } from './util'
import { hashPassword, verifyPassword, signToken, verifyToken } from './auth'
import {
  createUser,
  getUserByName,
  getUserById,
  listUsers,
  deleteUser,
  savePlaylist,
  listPlaylists,
  getPlaylist,
  deletePlaylist,
  getUserSetting,
  saveUserSetting,
  deleteUserSetting,
  listFavorites,
  addFavorite,
  removeFavorite,
} from './store'

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (request.method === 'OPTIONS') return json({})

    if (url.pathname === '/api/health') {
      return json({ ok: true, time: Date.now() })
    }

    // 夸克扫码登录：取二维码 / 轮询扫码结果
    if (url.pathname === '/api/quark/login/start' && request.method === 'POST') {
      try {
        return json(await startLogin(env.STREAM_SECRET))
      } catch (e) {
        return json({ error: errMsg(e) }, 502)
      }
    }
    if (url.pathname === '/api/quark/login/poll' && request.method === 'POST') {
      try {
        const b = (await request.json()) as { loginToken?: string }
        return json(await pollLogin(b.loginToken ?? '', env.STREAM_SECRET))
      } catch (e) {
        // 轮询期间网络抖动不该打断前端定时器，继续 waiting
        return json({ status: 'waiting', message: errMsg(e) })
      }
    }
    // 二维码在 Worker 内本地生成，不访问任何外部服务
    if (url.pathname === '/api/qr') {
      const data = url.searchParams.get('data') ?? ''
      if (!data || data.length > 1024) return new Response('bad request', { status: 400 })
      try {
        return new Response(qrSvg(data), {
          headers: {
            'Content-Type': 'image/svg+xml; charset=utf-8',
            'Cache-Control': 'no-store',
          },
        })
      } catch (e) {
        return new Response(`二维码生成失败：${errMsg(e)}`, { status: 400 })
      }
    }

    // 导入歌单：{ input: "链接或 id", platform?: "qq" | "netease" }
    if (url.pathname === '/api/playlist' && request.method === 'POST') {
      try {
        const body = (await request.json()) as { input?: string; platform?: 'qq' | 'netease' }
        const ref = await resolveRef(body.input ?? '', body.platform)
        if (!ref) return json({ error: '看不出是哪个平台的歌单，贴个完整链接试试' }, 400)
        const playlist = await fetchPlaylist(ref)
        return json(playlist)
      } catch (e) {
        return json({ error: errMsg(e) }, 502)
      }
    }

    // 找可播放的音源：夸克 → 网易云 → 酷我
    if (url.pathname === '/api/resolve' && request.method === 'POST') {
      try {
        const body = (await request.json()) as ResolveRequest
        const cookie =
          body.cookie ||
          request.headers.get('X-Quark-Cookie') ||
          env.QUARK_COOKIE ||
          ''
        const result = await resolveTrack({ ...body, cookie }, env.STREAM_SECRET)
        return json(result)
      } catch (e) {
        return json({ ok: false, notes: [], error: errMsg(e) }, 502)
      }
    }

    // 搜索点歌：网易云搜索，结果可直接点播
    if (url.pathname === '/api/search' && request.method === 'POST') {
      try {
        const body = (await request.json()) as { keyword?: string }
        const tracks = await searchTracks(body.keyword ?? '')
        return json({ tracks })
      } catch (e) {
        return json({ error: errMsg(e) }, 502)
      }
    }

    // 专辑封面：歌单元数据优先 → QQ → iTunes US（严格匹配打分）
    if (url.pathname === '/api/cover' && request.method === 'POST') {
      try {
        const body = (await request.json()) as {
          title?: string; artist?: string; album?: string; coverUrl?: string
        }
        const r = await fetchCover({
          title: body.title ?? '',
          artist: body.artist ?? '',
          album: body.album,
          coverUrl: body.coverUrl,
        })
        return json({ url: r.url, source: r.source, strict: r.strict })
      } catch (e) {
        return json({ url: null, source: 'none', strict: false, error: errMsg(e) }, 502)
      }
    }

    // 歌词：来源歌曲 id 直取优先（QQ / 网易云），失败再用酷狗、网易云搜索兜底
    if (url.pathname === '/api/lyric' && request.method === 'POST') {
      try {
        const body = (await request.json()) as {
          title?: string
          artist?: string
          platform?: string
          platformId?: string
        }
        const r = await fetchLyric(
          body.title ?? '',
          body.artist ?? '',
          body.platform,
          body.platformId
        )
        return json(r)
      } catch (e) {
        return json({ lyric: null, error: errMsg(e) }, 502)
      }
    }

    // 封面图代理：同源返回，浏览器 canvas 才能取色做氛围底（安卓是本地位图，没这问题）。
    // 只放行已知的封面 CDN，避免变成公开图片代理。
    if (url.pathname === '/api/cover-img') {
      const raw = url.searchParams.get('u') ?? ''
      let target: URL
      try { target = new URL(raw) } catch { return new Response('bad url', { status: 400 }) }
      if (target.protocol !== 'https:') return new Response('bad url', { status: 400 })
      const ok = [
        'p1.music.126.net', 'p2.music.126.net', 'p3.music.126.net', 'p4.music.126.net',
        'y.gtimg.cn', 'y.qq.com',
        'is1-ssl.mzstatic.com', 'is2-ssl.mzstatic.com', 'is3-ssl.mzstatic.com',
        'is4-ssl.mzstatic.com', 'is5-ssl.mzstatic.com',
      ].some((h) => target.hostname === h || target.hostname.endsWith('.' + h))
      if (!ok) return new Response('host not allowed', { status: 400 })
      const ref = target.hostname.includes('music.126.net') ? 'https://music.163.com/'
        : target.hostname.includes('gtimg') ? 'https://y.qq.com/' : 'https://itunes.apple.com/'
      const upstream = await http(target.toString(), {
        headers: { 'User-Agent': UA_PC, Referer: ref },
        timeoutMs: 12000,
      }).catch(() => null)
      if (!upstream || !upstream.ok) return new Response('cover not found', { status: 502 })
      const ct = upstream.headers.get('content-type') || ''
      if (!ct.startsWith('image/')) return new Response('not an image', { status: 502 })
      const out = new Headers()
      out.set('Content-Type', ct)
      out.set('Cache-Control', 'public, max-age=86400')
      out.set('Access-Control-Allow-Origin', '*')
      return new Response(upstream.body, { headers: out })
    }

    // ── 账户体系（自建账号 + 后台 admin888 管理 + D1 存歌单） ──────────────
    const bearer = (req: Request): string => {
      const h = req.headers.get('Authorization') || ''
      return h.startsWith('Bearer ') ? h.slice(7) : ''
    }
    const requireUser = async (req: Request): Promise<number | null> => {
      const c = await verifyToken(bearer(req), env.STREAM_SECRET)
      return c && c.role === 'user' ? c.sub : null
    }
    const requireAdmin = async (req: Request): Promise<boolean> => {
      const c = await verifyToken(bearer(req), env.STREAM_SECRET)
      return !!c && c.role === 'admin'
    }

    const adminPw = env.ADMIN_PASSWORD || 'admin888'

    // 后台登录（密码来自 ADMIN_PASSWORD，默认 admin888）
    if (url.pathname === '/api/admin/login' && request.method === 'POST') {
      const b = (await request.json().catch(() => ({}))) as { password?: string }
      if ((b.password ?? '') !== adminPw) return json({ error: '管理员密码错误' }, 401)
      const token = await signToken({ sub: 0, role: 'admin' }, env.STREAM_SECRET)
      return json({ token })
    }
    if (url.pathname === '/api/admin/users' && request.method === 'GET') {
      if (!(await requireAdmin(request))) return json({ error: '未授权' }, 401)
      return json(await listUsers(env.DB))
    }
    if (url.pathname === '/api/admin/users' && request.method === 'POST') {
      if (!(await requireAdmin(request))) return json({ error: '未授权' }, 401)
      const b = (await request.json().catch(() => ({}))) as { username?: string; password?: string }
      const username = (b.username ?? '').trim()
      const password = b.password ?? ''
      if (!username || !password) return json({ error: '用户名和密码必填' }, 400)
      if (await getUserByName(env.DB, username)) return json({ error: '用户名已存在' }, 409)
      await createUser(env.DB, username, await hashPassword(password))
      return json({ ok: true })
    }
    if (url.pathname.startsWith('/api/admin/users/') && request.method === 'DELETE') {
      if (!(await requireAdmin(request))) return json({ error: '未授权' }, 401)
      const id = Number(url.pathname.split('/').pop())
      if (id > 0) await deleteUser(env.DB, id)
      return json({ ok: true })
    }

    // 普通用户登录
    if (url.pathname === '/api/auth/login' && request.method === 'POST') {
      const b = (await request.json().catch(() => ({}))) as { username?: string; password?: string }
      const username = (b.username ?? '').trim()
      const u = await getUserByName(env.DB, username)
      if (!u || !(await verifyPassword(b.password ?? '', u.password_hash))) {
        return json({ error: '用户名或密码错误' }, 401)
      }
      const token = await signToken({ sub: u.id, role: 'user' }, env.STREAM_SECRET)
      return json({ token, username: u.username })
    }
    if (url.pathname === '/api/me' && request.method === 'GET') {
      const uid = await requireUser(request)
      if (!uid) return json({ error: '未登录' }, 401)
      const u = await getUserById(env.DB, uid)
      return json({ id: uid, username: u?.username ?? '' })
    }

    // 歌单同步（登录后可用）
    if (url.pathname === '/api/playlists' && request.method === 'GET') {
      const uid = await requireUser(request)
      if (!uid) return json({ error: '未登录' }, 401)
      return json(await listPlaylists(env.DB, uid))
    }
    if (url.pathname === '/api/playlists' && request.method === 'POST') {
      const uid = await requireUser(request)
      if (!uid) return json({ error: '未登录' }, 401)
      const b = (await request.json().catch(() => ({}))) as {
        name?: string; platform?: string; tracks?: unknown
      }
      const tracks = b.tracks
      if (!Array.isArray(tracks)) return json({ error: 'tracks 必须是数组' }, 400)
      const name = (b.name ?? '我的歌单').trim() || '我的歌单'
      const platform = (b.platform ?? 'netease').trim() || 'netease'
      const id = await savePlaylist(env.DB, uid, name, platform, JSON.stringify(tracks))
      return json({ id, name, platform })
    }
    if (url.pathname.startsWith('/api/playlists/') && request.method === 'GET') {
      const uid = await requireUser(request)
      if (!uid) return json({ error: '未登录' }, 401)
      const id = Number(url.pathname.split('/').pop())
      const pl = await getPlaylist(env.DB, id, uid)
      return pl ? json(pl) : json({ error: '找不到歌单' }, 404)
    }
    if (url.pathname.startsWith('/api/playlists/') && request.method === 'DELETE') {
      const uid = await requireUser(request)
      if (!uid) return json({ error: '未登录' }, 401)
      const id = Number(url.pathname.split('/').pop())
      await deletePlaylist(env.DB, id, uid)
      return json({ ok: true })
    }

    // 夸克 Cookie 云端同步（登录后可用；Cookie 用 AES-GCM 加密后存 D1）
    if (url.pathname === '/api/settings/quark' && request.method === 'GET') {
      const uid = await requireUser(request)
      if (!uid) return json({ error: '未登录' }, 401)
      const row = await getUserSetting(env.DB, uid)
      if (!row || !row.quark_cookie) return json({ hasCookie: false, updatedAt: 0 })
      const plain = await unseal<{ c?: string }>(row.quark_cookie, env.STREAM_SECRET)
      if (!plain?.c) return json({ hasCookie: false, updatedAt: 0 })
      return json({ hasCookie: true, cookie: plain.c, updatedAt: row.updated_at })
    }
    // 单独验一份 Cookie 还有效没有（只在两台设备冲突时才调用，不拖慢登录）
    if (url.pathname === '/api/settings/quark/check' && request.method === 'POST') {
      const uid = await requireUser(request)
      if (!uid) return json({ error: '未登录' }, 401)
      const b = (await request.json().catch(() => ({}))) as { cookie?: string }
      const v = await verifyQuarkCookie((b.cookie ?? '').trim())
      return json({ valid: v.valid, account: v.account || '' })
    }
    if (url.pathname === '/api/settings/quark' && request.method === 'POST') {
      const uid = await requireUser(request)
      if (!uid) return json({ error: '未登录' }, 401)
      const b = (await request.json().catch(() => ({}))) as { cookie?: string }
      const cookie = (b.cookie ?? '').trim()
      if (!cookie) {
        await deleteUserSetting(env.DB, uid)
        return json({ ok: true, updatedAt: Date.now(), cleared: true })
      }
      const sealed = await seal({ c: cookie }, env.STREAM_SECRET)
      const updatedAt = await saveUserSetting(env.DB, uid, sealed)
      return json({ ok: true, updatedAt })
    }
    if (url.pathname === '/api/settings/quark' && request.method === 'DELETE') {
      const uid = await requireUser(request)
      if (!uid) return json({ error: '未登录' }, 401)
      await deleteUserSetting(env.DB, uid)
      return json({ ok: true })
    }

    // 收藏（小红心）云端同步
    if (url.pathname === '/api/favorites' && request.method === 'GET') {
      const uid = await requireUser(request)
      if (!uid) return json({ error: '未登录' }, 401)
      const rows = await listFavorites(env.DB, uid)
      return json(
        rows.map((r) => {
          let track: unknown = null
          try { track = JSON.parse(r.track) } catch { track = null }
          return {
            key: r.key,
            track,
            deleted: !!r.deleted,
            createdAt: r.created_at,
            updatedAt: r.updated_at,
          }
        })
      )
    }
    if (url.pathname === '/api/favorites' && request.method === 'POST') {
      const uid = await requireUser(request)
      if (!uid) return json({ error: '未登录' }, 401)
      const b = (await request.json().catch(() => ({}))) as { key?: string; track?: unknown }
      const key = (b.key ?? '').trim()
      if (!key) return json({ error: 'key 必填' }, 400)
      if (!b.track || typeof b.track !== 'object') return json({ error: 'track 必填' }, 400)
      await addFavorite(env.DB, uid, key, JSON.stringify(b.track))
      return json({ ok: true, key })
    }
    if (url.pathname.startsWith('/api/favorites/') && request.method === 'DELETE') {
      const uid = await requireUser(request)
      if (!uid) return json({ error: '未登录' }, 401)
      const key = decodeURIComponent(url.pathname.slice('/api/favorites/'.length)).trim()
      if (!key) return json({ error: 'key 必填' }, 400)
      await removeFavorite(env.DB, uid, key)
      return json({ ok: true })
    }

    // 直链流式代理：令牌自包含上游地址 + Cookie，客户端看不到凭据
    if (url.pathname === '/api/stream') {
      const token = url.searchParams.get('t') ?? ''
      const payload = await unseal<StreamPayload>(token, env.STREAM_SECRET)
      if (!payload) return withCors(new Response('链接无效', { status: 400 }))
      if (payload.exp < Date.now()) {
        return withCors(new Response('链接已过期，重新点一次歌曲', { status: 410 }))
      }

      const h: Record<string, string> = {
        'User-Agent': payload.ua,
        Referer: payload.r,
      }
      if (payload.c) h.Cookie = payload.c
      const range = request.headers.get('range')
      if (range) h.Range = range

      const upstream = await http(payload.u, { headers: h, timeoutMs: 30000 }).catch(() => null)
      if (!upstream) return withCors(new Response('上游连不上', { status: 502 }))

      const out = new Headers()
      for (const k of [
        'content-type',
        'content-length',
        'content-range',
        'accept-ranges',
        'content-disposition',
        'etag',
        'last-modified',
        'cache-control',
      ]) {
        const v = upstream.headers.get(k)
        if (v) out.set(k, v)
      }
      if (!out.has('accept-ranges')) out.set('accept-ranges', 'bytes')
      out.set('Access-Control-Allow-Origin', '*')

      // 夸克 CDN 412 = Cookie / __puus 不匹配，明确告诉前端去刷新登录态
      if (upstream.status === 412) {
        out.set('X-Cloudmusic-Error', 'quark-412')
      }
      return new Response(upstream.body, { status: upstream.status, headers: out })
    }

    if (url.pathname.startsWith('/api/')) return json({ error: 'not found' }, 404)

    // 其余交给 PWA 静态资源
    return env.ASSETS.fetch(request)
  },
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
