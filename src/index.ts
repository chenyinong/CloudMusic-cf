import type { Env, ResolveRequest, StreamPayload } from './types'
import { fetchPlaylist, resolveRef, searchTracks } from './playlist'
import { pollLogin, startLogin } from './quark-login'
import { fetchCover } from './cover'
import { qrSvg } from './qr'
import { resolveTrack } from './sources'
import { fetchLyric } from './lyric'
import { http, json, unseal, withCors, UA_PC } from './util'

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
