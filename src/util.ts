export const UA_PC =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36'
export const UA_NETEASE =
  'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36'
export const UA_QQ =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'
export const QUARK_REFERER = 'https://pan.quark.cn/'

export const BYTES_PER_SEC = 16000
export const COMPLETE_RATIO = 0.85

export function enc(s: string): string {
  return encodeURIComponent(s)
}

/** 上游偶尔给 http 直链，统一升成 https。 */
export function https(u: string): string {
  return u.startsWith('http://') ? 'https://' + u.slice(7) : u
}

export interface HttpOptions {
  method?: string
  headers?: Record<string, string>
  body?: string
  redirect?: 'follow' | 'manual'
  timeoutMs?: number
  /** 外部取消信号：夸克命中后，公开源（网易云/酷我）的请求就没必要继续跑了 */
  signal?: AbortSignal
}

export async function http(url: string, opts: HttpOptions = {}): Promise<Response> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 9000)
  if (opts.signal) {
    if (opts.signal.aborted) ctl.abort()
    else opts.signal.addEventListener('abort', () => ctl.abort(), { once: true })
  }
  try {
    return await fetch(url, {
      method: opts.method ?? 'GET',
      headers: opts.headers ?? {},
      body: opts.body,
      redirect: opts.redirect ?? 'follow',
      signal: ctl.signal,
    })
  } finally {
    clearTimeout(timer)
  }
}

export async function getText(
  url: string,
  headers: Record<string, string>,
  timeoutMs = 9000,
  signal?: AbortSignal
): Promise<string> {
  const r = await http(url, { headers, timeoutMs, signal })
  const t = await r.text()
  if (!r.ok) throw new Error(`HTTP ${r.status}：${t.slice(0, 120)}`)
  return t
}

export async function getJson<T>(
  url: string,
  headers: Record<string, string>,
  timeoutMs = 9000,
  signal?: AbortSignal
): Promise<T> {
  return JSON.parse(await getText(url, headers, timeoutMs, signal)) as T
}

/** 夸克签发直链时会刷新 __puus，CDN 只认新值，必须合并进本条直链的 Cookie。 */
export function mergePuus(cookie: string, setCookies: string[]): string {
  const fresh = setCookies
    .map((c) => c.split(';')[0].trim())
    .find((c) => c.startsWith('__puus='))
  if (!fresh) return cookie
  const parts = new Map<string, string>()
  for (const p of cookie.split(';')) {
    const t = p.trim()
    const i = t.indexOf('=')
    if (i > 0) parts.set(t.slice(0, i), t.slice(i + 1))
  }
  const i = fresh.indexOf('=')
  if (i > 0) parts.set(fresh.slice(0, i), fresh.slice(i + 1))
  return [...parts].map(([k, v]) => `${k}=${v}`).join('; ')
}

/** 把一组 Set-Cookie 合并进现有 Cookie（同名覆盖），用于扫码登录时逐跳收集。 */
export function mergeCookies(base: string, setCookies: string[]): string {
  const parts = new Map<string, string>()
  for (const p of base.split(';')) {
    const t = p.trim()
    const i = t.indexOf('=')
    if (i > 0) parts.set(t.slice(0, i), t.slice(i + 1))
  }
  for (const sc of setCookies) {
    const first = sc.split(';')[0].trim()
    const i = first.indexOf('=')
    if (i > 0) parts.set(first.slice(0, i), first.slice(i + 1))
  }
  return [...parts].map(([k, v]) => `${k}=${v}`).join('; ')
}

export function setCookiesOf(resp: Response): string[] {
  const h = resp.headers as Headers & { getSetCookie?: () => string[] }
  if (typeof h.getSetCookie === 'function') return h.getSetCookie()
  const one = resp.headers.get('set-cookie')
  return one ? [one] : []
}

/**
 * 探活：只读前 8KB，顺带从 Content-Range 拿到文件总长度。
 * 用总长度比标称时长来判断是不是 30 秒试听片段（跟 Android 客户端一致）。
 */
export async function probeAudio(
  url: string,
  headers: Record<string, string>
): Promise<{ ok: boolean; total: number }> {
  const r = await http(url, {
    headers: { ...headers, Range: 'bytes=0-8191' },
    timeoutMs: 9000,
  })
  if (!r.ok && r.status !== 206) {
    await r.body?.cancel()
    return { ok: false, total: 0 }
  }
  const ct = r.headers.get('content-type') ?? ''
  if (/text\/html|application\/json/i.test(ct)) {
    await r.body?.cancel()
    return { ok: false, total: 0 }
  }
  const cr = r.headers.get('content-range')
  const m = cr ? /\/(\d+)/.exec(cr) : null
  const total = m ? Number(m[1]) : Number(r.headers.get('content-length') ?? '0')
  await r.body?.cancel()
  return { ok: true, total }
}

export function bytesLookPartial(total: number, durationSec: number): boolean {
  if (total <= 0 || durationSec <= 0) return false
  return total < durationSec * BYTES_PER_SEC * COMPLETE_RATIO
}

const te = new TextEncoder()
const td = new TextDecoder()

function b64u(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function unb64u(s: string): Uint8Array {
  const t = s.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(t + '='.repeat((4 - (t.length % 4)) % 4))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function aesKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest('SHA-256', te.encode(secret))
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

/** 把直链和 Cookie 封进短时效令牌，避免变成公开代理、也不把 Cookie 暴露在 URL 上。 */
export async function seal(obj: unknown, secret: string): Promise<string> {
  const key = await aesKey(secret)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, te.encode(JSON.stringify(obj)))
  )
  return `${b64u(iv)}.${b64u(ct)}`
}

export async function unseal<T>(token: string, secret: string): Promise<T | null> {
  try {
    const [a, b] = token.split('.')
    if (!a || !b) return null
    const key = await aesKey(secret)
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unb64u(a) },
      key,
      unb64u(b)
    )
    return JSON.parse(td.decode(plain)) as T
  } catch {
    return null
  }
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, X-Quark-Cookie',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    },
  })
}

export function withCors(resp: Response): Response {
  const h = new Headers(resp.headers)
  h.set('Access-Control-Allow-Origin', '*')
  h.set('Access-Control-Allow-Headers', 'Content-Type, X-Quark-Cookie')
  h.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: h })
}
