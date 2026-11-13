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
  /** 夸克报的真实时长（秒），判断是不是试听片段优先用它 */
  durationSec: number
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
  // 列自己网盘根目录：必须登录才拿得到，这才是真的登录态。
  // （会员信息接口游客态也返回 code=0，Cookie 过期了照样判成「已登录」——
  //   安卓端踩过这个坑，这里跟着它走。）
  try {
    const r = await http(
      `${HOST}/1/clouddrive/file/sort?pr=ucpro&fr=pc&pdir_fid=0&_page=1&_size=1&_fetch_total=1`,
      {
        headers: { 'User-Agent': UA_PC, Referer: 'https://pan.quark.cn/', Cookie: cookie },
        timeoutMs: 6000,
      }
    )
    if (r.status === 401 || r.status === 403) return { valid: false, account: '' }
    const j = (await r.json().catch(() => null)) as any
    if (!j) return { valid: null, account: '' }
    const code = j?.code ?? j?.status
    if (code !== undefined && code !== null && Number(code) !== 0) {
      return { valid: false, account: '' }
    }
    if (!j?.data || !('list' in j.data)) return { valid: false, account: '' }
    return { valid: true, account: await quarkNickname(cookie) }
  } catch {
    return { valid: null, account: '' }
  }
}

/** 账号昵称，只用来显示，拿不到不影响「有效」这个结论。 */
async function quarkNickname(cookie: string): Promise<string> {
  try {
    const r = await http(`${PAN}/account/info`, {
      headers: { 'User-Agent': UA_PC, Referer: 'https://pan.quark.cn/', Cookie: cookie },
      timeoutMs: 5000,
    })
    if (!r.ok) return ''
    const j = (await r.json().catch(() => null)) as any
    return String(j?.data?.member?.nickname ?? j?.data?.nickname ?? '')
  } catch {
    return ''
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
  /** 夸克报的真实时长（秒），0 表示没有 */
  durationSec: number
}

const stokenCache = new Map<string, CacheEntry<string>>()
const shareFileCache = new Map<string, CacheEntry<ShareFile[]>>()

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
  cookie: string,
  onProgress?: () => void
): Promise<ShareFile[]> {
  const files = await listShareDir(pwdId, stoken, cookie, '', onProgress)
  const audio = files.filter((f) => AUDIO_EXT.test(f.fileName))
  if (audio.length) return sortByQuality(audio)
  // 分享根目录只有文件夹 → 往里走一层（很多网盘分享是「一个文件夹」）
  const dirs = files.filter((f) => f.isDir)
  const out: ShareFile[] = []
  for (const d of dirs.slice(0, 5)) {
    const sub = await listShareDir(pwdId, stoken, cookie, d.fid, onProgress)
    out.push(...sub.filter((f) => AUDIO_EXT.test(f.fileName)))
    if (out.length >= 5) break
  }
  return sortByQuality(out)
}

/** 音质从高到低（flac > wav > mp3），同音质按大小排。 */
function sortByQuality(list: ShareFile[]): ShareFile[] {
  return list
    .slice()
    .sort(
      (a, b) =>
        quality(b.fileName) - quality(a.fileName) || b.size - a.size
    )
}

/** 列分享里某一层的文件（pdirFid 为空 = 根目录）。 */
async function listShareDir(
  pwdId: string,
  stoken: string,
  cookie: string,
  pdirFid: string,
  onProgress?: () => void
): Promise<Array<ShareFile & { isDir: boolean }>> {
  const detailUrl =
    `${HOST}/1/clouddrive/share/sharepage/detail?pr=ucpro&fr=pc` +
    `&pwd_id=${enc(pwdId)}&stoken=${enc(stoken)}` +
    (pdirFid ? `&pdir_fid=${enc(pdirFid)}` : '') +
    `&_fetch_share=1&_fetch_banner=1&_fetch_total=1&_page=1&_size=100`
  const dJson = await getJson<any>(detailUrl, headers(cookie)).catch(() => null)
  onProgress?.()
  const list: any[] = dJson?.data?.list ?? []
  return list.map((x: any) => ({
    fid: String(x.fid ?? ''),
    fileName: String(x.file_name ?? 'audio'),
    size: Number(x.size ?? 0),
    durationSec: Number(x.duration ?? 0),
    isDir: !!x.dir || Number(x.dir_fid ?? 0) > 0,
  }))
}

/** 3) 签直链，同时把刷新的 __puus 合进 Cookie */
async function signDownload(
  pwdId: string,
  stoken: string,
  fid: string,
  cookie: string
): Promise<{ url: string; cookie: string; size: number; durationSec: number } | null> {
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
    durationSec: Number(dlJson?.data?.[0]?.duration ?? 0),
  }
}

/**
 * 探一下签出来的直链到底能不能下。
 *
 * 直链是跟签发那次的 Cookie（__puus）绑定的，Cookie 不匹配时 CDN 一律 412，
 * 这种链接交给前端也是 412 白跑一趟，不如当场丢掉换下一个文件。
 *
 *   'ok'      —— 能下
 *   'denied'  —— 412 / 404：这条直链废了（Cookie 对不上、分享没了），换下一个
 *   'unknown' —— 网络抖动之类判断不了：照样给出去，别因为边缘节点抽风就误杀好资源
 */
async function probeSigned(
  url: string,
  cookie: string
): Promise<'ok' | 'denied' | 'unknown'> {
  try {
    const r = await http(url, {
      headers: {
        'User-Agent': UA_PC,
        Referer: QUARK_REFERER,
        Cookie: cookie,
        Range: 'bytes=0-8191',
      },
      timeoutMs: 4000,
    })
    if (r.status === 412 || r.status === 404) {
      await r.body?.cancel()
      return 'denied'
    }
    if (!r.ok && r.status !== 206) {
      await r.body?.cancel()
      return 'unknown'
    }
    const ct = r.headers.get('content-type') ?? ''
    await r.body?.cancel()
    return /text\/html|application\/json/i.test(ct) ? 'unknown' : 'ok'
  } catch {
    return 'unknown'
  }
}

/**
 * @param probe 签完要不要再探一次直链（一次完整的跨境往返，约 0.7~1.2s）。
 *              后台预取传 false：坏链交给播放时的 fresh 重试阶梯处理，
 *              没必要让每首预取都白付这一跳。
 */
export async function quarkDirect(
  shareUrl: string,
  cookie: string,
  onProgress?: () => void,
  probe = true
): Promise<QuarkDirect | null> {
  const pwdId = pwdIdOf(shareUrl)
  if (!pwdId || !cookie.trim()) return null

  const tk = `${pwdId}|${cookieKey(cookie)}`
  /** 探测下来「直链废了」的候选，留着当最后兜底 */
  let denied: QuarkDirect | null = null

  // 最多两轮：第一轮吃缓存，签发失败（stoken/fid 过期）就清缓存重跑一次
  for (let attempt = 0; attempt < 2; attempt++) {
    let stoken = ''
    const st = stokenCache.get(tk)
    if (st && Date.now() - st.at < STOKEN_TTL) stoken = st.v

    let files: ShareFile[] | null = null
    const sf = shareFileCache.get(pwdId)
    if (sf && Date.now() - sf.at < SHARE_FILE_TTL) files = sf.v

    if (!stoken) {
      const fresh = await fetchStoken(pwdId, cookie).catch(() => null)
      onProgress?.()
      if (!fresh) return null
      stoken = fresh
      putCache(stokenCache, tk, stoken, STOKEN_MAX)
    }
    if (!files) {
      const list = await fetchShareFiles(pwdId, stoken, cookie, onProgress).catch(() => null)
      if (!list || !list.length) return null
      files = list
      putCache(shareFileCache, pwdId, files, SHARE_FILE_MAX)
    }

    // 分享里可能有多个音频（不同音质），挨个签：一个不行换下一个
    for (const f of files) {
      if (!f.fid) continue
      const dl = await signDownload(pwdId, stoken, f.fid, cookie).catch(() => null)
      onProgress?.()
      if (!dl) continue
      const cand: QuarkDirect = {
        url: dl.url,
        cookie: dl.cookie,
        fileName: f.fileName,
        size: f.size || dl.size,
        durationSec: f.durationSec || dl.durationSec,
      }
      // 后台预取不探活：这一跳跨境往返要 0.7~1.2 秒，而坏链播放时有重试阶梯。
      // 只签一次、直接给结果，是冷解析里最省时间的一刀。
      if (!probe) return cand
      // 签完先探一下：412 说明 Cookie 跟直链对不上，这条废了，换下一个文件/分享
      const state = await probeSigned(dl.url, dl.cookie)
      onProgress?.()
      if (state === 'denied') {
        // 留个底：全都被拒时还是把它给出去，让前端按老规矩重试，
        // 别因为一次探测就把整首歌判成「没找到」
        denied ??= cand
        continue
      }
      return cand
    }

    // 签不出来：多半是 stoken/fid 过期了，把缓存作废，下一轮重来
    shareFileCache.delete(pwdId)
    stokenCache.delete(tk)
  }
  return denied
}
