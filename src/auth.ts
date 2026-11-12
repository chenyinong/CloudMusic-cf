// 账户体系：PBKDF2 密码哈希 + HMAC 会话令牌（基于 Web Crypto，Worker 原生支持）。
const te = new TextEncoder()

function b64url(b: ArrayBuffer | Uint8Array): string {
  const bytes = b instanceof Uint8Array ? b : new Uint8Array(b)
  let s = ''
  for (const x of bytes) s += String.fromCharCode(x)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function unb64url(s: string): Uint8Array {
  const t = s.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(t + '='.repeat((4 - (t.length % 4)) % 4))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

const ITER = 100_000

/** 加盐 PBKDF2-SHA256，返回 `saltB64|hashB64` */
export async function hashPassword(pw: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const key = await crypto.subtle.importKey('raw', te.encode(pw), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: ITER, hash: 'SHA-256' },
    key,
    256
  )
  return b64url(salt) + '|' + b64url(bits)
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [saltB64, hashB64] = stored.split('|')
  if (!saltB64 || !hashB64) return false
  const salt = unb64url(saltB64)
  const key = await crypto.subtle.importKey('raw', te.encode(pw), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: ITER, hash: 'SHA-256' },
    key,
    256
  )
  const got = b64url(bits)
  if (got.length !== hashB64.length) return false
  let diff = 0
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ hashB64.charCodeAt(i)
  return diff === 0
}

interface Claims {
  sub: number
  role: 'admin' | 'user'
  exp: number
}

async function hmac(data: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    te.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', key, te.encode(data))
  return b64url(sig)
}

/** 签发 HMAC-SHA256 令牌（类 JWT 三段式），默认 30 天有效 */
export async function signToken(
  claims: { sub: number; role: 'admin' | 'user' },
  secret: string,
  ttlSec = 60 * 60 * 24 * 30
): Promise<string> {
  const h = b64url(te.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })))
  const p = b64url(te.encode(JSON.stringify({ ...claims, exp: Date.now() + ttlSec * 1000 })))
  const data = `${h}.${p}`
  return `${data}.${await hmac(data, secret)}`
}

export async function verifyToken(token: string, secret: string): Promise<Claims | null> {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [h, p, sig] = parts
  if ((await hmac(`${h}.${p}`, secret)) !== sig) return null
  try {
    const payload = JSON.parse(new TextDecoder().decode(unb64url(p))) as Claims
    if (payload.exp && payload.exp < Date.now()) return null
    return payload
  } catch {
    return null
  }
}
