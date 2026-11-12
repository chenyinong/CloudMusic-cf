/**
 * 夸克网盘直链（下歌吧给的是分享链接，需要三段式换直链）。
 * 协议照搬 Android 客户端 QuarkClient。
 *
 * 最关键的一点：file/download 的响应会刷新 __puus，CDN 只认刷新后的值，
 * 拿登录时那份旧 Cookie 去 GET 直链一律 412。所以每条直链各带各的 Cookie。
 */
import {
  QUARK_REFERER,
  UA_PC,
  enc,
  getJson,
  https,
  http,
  mergePuus,
  setCookiesOf,
} from './util'

const HOST = 'https://drive-pc.quark.cn'
const PAN = 'https://pan.quark.cn'
const AUDIO_EXT = /\.(mp3|flac|wav|m4a|aac|ogg|ape)$/i

export interface QuarkDirect {
  url: string
  cookie: string
  fileName: string
  size: number
}

function headers(cookie: string): Record<string, string> {
  return {
    'User-Agent': UA_PC,
    Referer: QUARK_REFERER,
    'Content-Type': 'application/json',
    Cookie: cookie,
  }
}

export function pwdIdOf(share: string): string | null {
  const m = /pan\.quark\.cn\/s\/([A-Za-z0-9]+)/.exec(share)
  if (m) return m[1]
  const s = share.trim()
  return /^[A-Za-z0-9]{8,20}$/.test(s) ? s : null
}

/**
 * 检查夸克 Cookie 是否还有效。
 * valid = true/false 是明确结论；null 表示判断不出来（网络异常、接口返回异常），
 * 这时前端应保持原有逻辑，不要因为「判断不出」就覆盖本机 Cookie。
 */
export async function verifyQuarkCookie(
  cookie: string
): Promise<{ valid: boolean | null; account: string }> {
  if (!cookie || !cookie.includes('__pus')) return { valid: false, account: '' }
  try {
    const r = await http(`${PAN}/account/info`, {
      headers: { 'User-Agent': UA_PC, Referer: 'https://pan.quark.cn/', Cookie: cookie },
      timeoutMs: 5000,
    })
    if (r.status === 401 || r.status === 403) return { valid: false, account: '' }
    if (!r.ok) return { valid: null, account: '' }
    const j = (await r.json().catch(() => null)) as any
    if (!j) return { valid: null, account: '' }
    const nickname = String(j?.data?.member?.nickname ?? j?.data?.nickname ?? '')
    if (nickname) return { valid: true, account: nickname }
    const code = j?.code ?? j?.status
    if (code !== undefined && code !== null && Number(code) !== 0) {
      return { valid: false, account: '' }
    }
    return { valid: true, account: nickname }
  } catch {
    return { valid: null, account: '' }
  }
}

function quality(name: string): number {
  if (/\.flac$/i.test(name)) return 5
  if (/\.wav$/i.test(name)) return 4
  if (/\.mp3$/i.test(name)) return 3
  return 1
}

/* ══════════════ 缓存 ══════════════
 * 换直链要三轮往返：拿 stoken → 列分享里的文件 → 签直链。
 * 其中：
 *   · stoken 跟账号走，按「分享 + 账号」存，命中省掉第 1 轮（~210ms）
 *   · 分享里的文件（fid/文件名/大小）跟账号无关，所有人共用一份，
 *     命中省掉第 2 轮（~180ms）
 * 签发失败（stoken/fid 过期）会自动作废缓存重跑一次，不会把坏结果留在缓存里。
 */
const STOKEN_TTL = 10 * 60 * 1000
const SHARE_FILE_TTL = 30 * 60 * 1000
const STOKEN_MAX = 200
const SHARE_FILE_MAX = 300

interface CacheEntry<T> {
  v: T
  at: number
}

interface ShareFile {
  fid: string
  fileName: string
  size: number
}

const stokenCache = new Map<string, CacheEntry<string>>()
const shareFileCache = new Map<string, CacheEntry<ShareFile>>()

/** Cookie 摘要：stoken 按账号分开存（换账号不会串味）。 */
function cookieKey(cookie: string): string {
  let h = 0
  for (let i = 0; i < cookie.length; i++) h = (h * 31 + cookie.charCodeAt(i)) | 0
  return String(h)
}

function putCache<T>(m: Map<string, CacheEntry<T>>, k: string, v: T, max: number): void {
  if (m.size >= max) {
    let oldestKey = ''
    let oldestAt = Infinity
    for (const [kk, vv] of m) {
      if (vv.at < oldestAt) {
        oldestAt = vv.at
        oldestKey = kk
      }
    }
    if (oldestKey) m.delete(oldestKey)
  }
  m.set(k, { v, at: Date.now() })
}

/** 1) 拿分享的 stoken */
async function fetchStoken(pwdId: string, cookie: string): Promise<string | null> {
  const tokenRes = await http(`${HOST}/1/clouddrive/share/sharepage/token?pr=ucpro&fr=pc`, {
    method: 'POST',
    headers: headers(cookie),
    body: JSON.stringify({ pwd_id: pwdId, passcode: '' }),
  })
  const tokenJson = (await tokenRes.json().catch(() => null)) as any
  return tokenJson?.data?.stoken ?? null
}

/** 2) 列分享里的音频，挑音质最高的那个 */
async function fetchShareFiles(
  pwdId: string,
  stoken: string,
  cookie: string
): Promise<ShareFile[]> {
  const detailUrl =
    `${HOST}/1/clouddrive/share/sharepage/detail?pr=ucpro&fr=pc` +
    `&pwd_id=${enc(pwdId)}&stoken=${enc(stoken)}` +
    `&_fetch_share=1&_fetch_banner=1&_fetch_total=1&_page=1&_size=100`
  const dJson = await getJson<any>(detailUrl, headers(cookie)).catch(() => null)
  const files: any[] = (dJson?.data?.list ?? []).filter((f: any) =>
    AUDIO_EXT.test(String(f.file_name ?? ''))
  )
  if (!files.length) return []
  files.sort(
    (a, b) =>
      quality(String(b.file_name)) - quality(String(a.file_name)) ||
      Number(b.size ?? 0) - Number(a.size ?? 0)
  )
  const f = files[0]
  return [
    {
      fid: String(f.fid ?? ''),
      fileName: String(f.file_name ?? 'audio'),
      size: Number(f.size ?? 0),
    },
  ]
}

/** 3) 签直链，同时把刷新的 __puus 合进 Cookie */
async function signDownload(
  pwdId: string,
  stoken: string,
  fid: string,
  cookie: string
): Promise<{ url: string; cookie: string; size: number } | null> {
  const dlRes = await http(`${HOST}/1/clouddrive/file/download?pr=ucpro&fr=pc`, {
    method: 'POST',
    headers: headers(cookie),
    body: JSON.stringify({
      fid_list: [fid],
      fids: [fid],
      pwd_id: pwdId,
      stoken,
    }),
  })
  const linkCookie = mergePuus(cookie, setCookiesOf(dlRes))
  const dlJson = (await dlRes.json().catch(() => null)) as any
  const url = dlJson?.data?.[0]?.download_url
  if (!url) return null
  return {
    url: https(String(url)),
    cookie: linkCookie,
    size: Number(dlJson?.data?.[0]?.size ?? 0),
  }
}

export async function quarkDirect(shareUrl: string, cookie: string): Promise<QuarkDirect | null> {
  const pwdId = pwdIdOf(shareUrl)
  if (!pwdId || !cookie.trim()) return null

  const tk = `${pwdId}|${cookieKey(cookie)}`

  // 最多两轮：第一轮吃缓存，签发失败（stoken/fid 过期）就清缓存重跑一次
  for (let attempt = 0; attempt < 2; attempt++) {
    let stoken = ''
    const st = stokenCache.get(tk)
    if (st && Date.now() - st.at < STOKEN_TTL) stoken = st.v

    let file: ShareFile | null = null
    const sf = shareFileCache.get(pwdId)
    if (sf && Date.now() - sf.at < SHARE_FILE_TTL) file = sf.v

    if (!stoken) {
      const fresh = await fetchStoken(pwdId, cookie).catch(() => null)
      if (!fresh) return null
      stoken = fresh
      putCache(stokenCache, tk, stoken, STOKEN_MAX)
    }
    if (!file) {
      const files = await fetchShareFiles(pwdId, stoken, cookie).catch(() => null)
      if (!files || !files.length) return null
      file = files[0]
      putCache(shareFileCache, pwdId, file, SHARE_FILE_MAX)
    }
    if (!file.fid) return null

    const dl = await signDownload(pwdId, stoken, file.fid, cookie).catch(() => null)
    if (dl) {
      return {
        url: dl.url,
        cookie: dl.cookie,
        fileName: file.fileName,
        size: file.size || dl.size,
      }
    }

    // 签不出来：多半是 stoken/fid 过期了，把缓存作废，下一轮重来
    shareFileCache.delete(pwdId)
    stokenCache.delete(tk)
  }
  return null
}
