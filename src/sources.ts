/**
 * 音源解析：下歌吧 + 夸克（完整版主力）→ 网易云 → 酷我。
 *
 * 与 Android 客户端 resolveForOnlinePlay 保持同一套策略：
 * 夸克已登录时排第一；命中的片段只记下来继续找完整版；全是片段才兜底返回。
 */
import type { ResolveRequest, Resolved, StreamPayload } from './types'
import {
  BYTES_PER_SEC,
  QUARK_REFERER,
  UA_NETEASE,
  UA_PC,
  bytesLookPartial,
  enc,
  getJson,
  getText,
  https,
  http,
  probeAudio,
  seal,
} from './util'
import { ABSOLUTE_PARTIAL_MAX_SEC, artistHit, keywords, sameTitle } from './match'
import { quarkDirect } from './quark'

const LMY = 'https://so.liumingye.cn'
const NETEASE = 'https://music.163.com'
const KUWO_SEARCH = 'https://search.kuwo.cn'
const KUWO_ANTI = 'https://antiserver.kuwo.cn'

const LMY_HEADERS = {
  'User-Agent': UA_PC,
  Accept: 'application/json, text/plain, */*',
  Referer: `${LMY}/`,
}
const NE_HEADERS = { 'User-Agent': UA_NETEASE, Referer: `${NETEASE}/` }
const KW_HEADERS = { 'User-Agent': UA_PC, Referer: `${KUWO_SEARCH}/` }

/** 夸克多久还没出结果，就先启动公开源兜底（夸克是主力，别一上来就打扰别人） */
const PUBLIC_DELAY_MS = 1500
/** 夸克整路上限，超时按「没找到」处理，交给公开源 */
const QUARK_CAP_MS = 3000

/** 把异常压成一句话，方便塞进 notes */
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

interface Cand {
  url: string
  source: string
  ref: string
  ua: string
  cookie?: string
  title: string
  fileName?: string
  total: number
}

export interface ResolveResult {
  ok: boolean
  resolved?: Resolved
  notes: string[]
  error?: string
}

/**
 * 解析结果缓存：同一首歌反复切（列表来回点、上一首下一首）时，10 分钟内
 * 直接复用上次的结果，避免每次都重新搜源 + 探活 + 签发令牌。
 * 这是 Worker 实例内存缓存，冷启动/多实例之间不共享，但已经能吃掉绝大部分重复解析。
 */
const RESOLVE_TTL = 10 * 60 * 1000
const RESOLVE_CACHE_MAX = 200
const resolveCache = new Map<string, { at: number; res: ResolveResult }>()
/** 同一首歌正在解析时，第二个请求直接等第一个的结果（预取和播放常常同时到） */
const resolveInflight = new Map<string, Promise<ResolveResult>>()

function resolveCacheKey(req: ResolveRequest): string {
  // Cookie 变了（换账号/过期）缓存必须失效，所以把它一起算进 key
  const ck = req.cookie ?? ''
  let ckHash = 0
  for (let i = 0; i < ck.length; i++) ckHash = (ckHash * 31 + ck.charCodeAt(i)) | 0
  return [
    req.title,
    req.artist,
    req.platformId ?? '',
    req.quarkId ?? '',
    Math.round(req.durationSec || 0),
    ck ? String(ckHash) : '',
  ].join('|')
}

export async function resolveTrack(req: ResolveRequest, secret: string): Promise<ResolveResult> {
  const key = resolveCacheKey(req)
  const hit = resolveCache.get(key)
  // fresh=true 是「上次给的直链播不了，重来一次」，不能吃缓存
  if (!req.fresh && hit && Date.now() - hit.at < RESOLVE_TTL) {
    return { ...hit.res, notes: [...hit.res.notes, '命中解析缓存（10 分钟内复用上次结果）'] }
  }
  const flying = resolveInflight.get(key)
  if (flying) return flying

  const p = resolveTrackInner(req, secret)
    .then((res) => {
      resolveInflight.delete(key)
      if (res.ok) {
        if (resolveCache.size >= RESOLVE_CACHE_MAX) {
          let oldestKey = ''
          let oldestAt = Infinity
          for (const [k, v] of resolveCache) {
            if (v.at < oldestAt) { oldestAt = v.at; oldestKey = k }
          }
          if (oldestKey) resolveCache.delete(oldestKey)
        }
        resolveCache.set(key, { at: Date.now(), res })
      }
      return res
    })
    .catch((e) => {
      resolveInflight.delete(key)
      throw e
    })
  resolveInflight.set(key, p)
  return p
}

async function resolveTrackInner(req: ResolveRequest, secret: string): Promise<ResolveResult> {
  const notes: string[] = []
  const tAll = Date.now()
  const cookie = (req.cookie ?? '').trim()
  const kws = keywords(req.title, req.artist)
  let partialFallback: Cand | null = null

  /** 探活 + 片段判定。片段留作兜底，继续找完整版。 */
  async function probe(c: Cand): Promise<'ok' | 'partial' | 'dead'> {
    const h: Record<string, string> = { 'User-Agent': c.ua, Referer: c.ref }
    if (c.cookie) h.Cookie = c.cookie
    const t0 = Date.now()
    let p: { ok: boolean; total: number }
    try {
      p = await probeAudio(c.url, h)
    } catch {
      notes.push(`${c.source}：探活失败（${Date.now() - t0}ms）`)
      return 'dead'
    }
    const ms = Date.now() - t0
    if (!p.ok) {
      notes.push(`${c.source}：直链读不到音频（${ms}ms）`)
      return 'dead'
    }
    c.total = p.total
    const mb = (p.total / 1048576).toFixed(1)
    const byBytes = bytesLookPartial(p.total, req.durationSec)
    const byAbsolute =
      req.durationSec <= 0 && p.total > 0 && p.total < ABSOLUTE_PARTIAL_MAX_SEC * BYTES_PER_SEC
    if (byBytes || byAbsolute) {
      notes.push(`${c.source}「${c.fileName ?? c.title}」只有试听片段（${mb}MB，${ms}ms），继续找完整版`)
      partialFallback ??= c
      return 'partial'
    }
    notes.push(`${c.source}「${c.fileName ?? c.title}」拿到完整版（${mb}MB，${ms}ms）`)
    return 'ok'
  }

  const done = async (c: Cand, partial: boolean): Promise<ResolveResult> => {
    const payload: StreamPayload = {
      u: c.url,
      c: c.cookie,
      r: c.ref,
      ua: c.ua,
      exp: Date.now() + 2 * 60 * 60 * 1000,
    }
    const token = await seal(payload, secret)
    notes.push(`⏱ 总耗时 ${Date.now() - tAll}ms`)
    // 并行探活时 notes 顺序会乱，取本音源的最后一条说明
    const note =
      [...notes].reverse().find((n) => n.startsWith(c.source)) ?? notes[notes.length - 1] ?? ''
    const resolved: Resolved = {
      url: `/api/stream?t=${encodeURIComponent(token)}`,
      source: c.source,
      partial,
      durationSec: req.durationSec,
      note,
      fileName: c.fileName,
    }
    // 复制一份：夸克超时的尾巴还可能往 notes 里追加，别污染缓存里的结果
    return { ok: true, resolved, notes: [...notes] }
  }

  // ── 夸克优先 ──────────────────────────────────────────────────────────
  /** 夸克候选：签发直链 + 用签发时带回来的文件大小判是不是试听片段（省一次探活往返）。 */
  const quarkSign = async (h: LmyHit): Promise<Cand | null> => {
    const t0 = Date.now()
    let c: Cand | null = null
    try {
      c = await quarkCandById(h.id, cookie)
    } catch (e) {
      notes.push(`夸克「${h.title}」签发失败（${errMsg(e)}，${Date.now() - t0}ms）`)
      return null
    }
    if (!c) {
      notes.push(`夸克「${h.title}」拿不到直链（${Date.now() - t0}ms）`)
      return null
    }
    c.title = h.title
    const mb = (c.total / 1048576).toFixed(1)
    if (quarkIsPartial(c.total, req.durationSec)) {
      notes.push(`夸克「${h.title}」只有试听片段（${mb}MB，${Date.now() - t0}ms），继续找完整版`)
      partialFallback ??= c
      return null
    }
    notes.push(`夸克「${h.title}」拿到完整版（${mb}MB，${Date.now() - t0}ms）`)
    return c
  }

  const quarkP = (async () => {
    if (req.skipQuark) {
      notes.push('夸克：本次跳过（直链反复失效，改用公开源）')
      return null
    }
    if (!cookie) {
      notes.push('夸克：未填 Cookie，跳过（只用公开源）')
      return null
    }
    // 搜歌结果里点了某条网盘资源 → 直接用它，别再搜一遍挑同名文件
    if (req.quarkId) {
      const c = await quarkCandById(req.quarkId, cookie).catch(() => null)
      if (!c) {
        notes.push('夸克：指定的网盘资源不可用，改走搜索')
      } else {
        c.title = req.title
        const mb = (c.total / 1048576).toFixed(1)
        if (quarkIsPartial(c.total, req.durationSec)) {
          notes.push(`夸克：指定资源只有试听片段（${mb}MB），改走搜索`)
        } else {
          notes.push(`夸克：指定资源「${c.fileName}」拿到完整版（${mb}MB）`)
          return c
        }
      }
    }
    const hits = await lmySearch(kws[0] ?? '')
    notes.push(`下歌吧：搜到 ${hits.length} 条`)
    const same = hits.filter((h) => sameTitle(h.title, req.title))
    const ordered = (same.length ? same : hits).sort(
      (a, b) => Number(artistHit(req.artist, b.artist)) - Number(artistHit(req.artist, a.artist))
    )
    const top = ordered.slice(0, 3)
    if (!top.length) return null
    const tCand = Date.now()
    // 先签第一个：中了就收工，省掉另外两个候选的签发往返；
    // 不中再把剩下的并行签，别一个个排队等
    const first = await quarkSign(top[0])
    if (first) return first
    const rest = await Promise.all(top.slice(1).map(quarkSign))
    notes.push(`下歌吧：候选签发共 ${Date.now() - tCand}ms`)
    return rest.find((c): c is Cand => !!c) ?? null
  })()

  // ── 公开源：延迟启动 ──────────────────────────────────────────────────
  // 完整版基本都在夸克，所以夸克没出结果之前不去打扰网易云/酷我：
  // 命中时能省掉 4~8 个请求，也少被上游限流。夸克慢了/挂了再启动它们兜底。
  let publicP: Promise<[Collected, Collected]> | null = null
  let abortPublic: () => void = () => {}
  const startPublic = (): Promise<[Collected, Collected]> => {
    if (!publicP) {
      const ctl = new AbortController()
      abortPublic = () => ctl.abort()
      publicP = Promise.all([
        collectNetease(req, kws, ctl.signal),
        collectKuwo(req, kws, ctl.signal),
      ]).catch(
        () =>
          [
            { cands: [], notes: [] },
            { cands: [], notes: [] },
          ] as [Collected, Collected]
      )
    }
    return publicP
  }

  const publicTimer = setTimeout(() => {
    void startPublic()
  }, PUBLIC_DELAY_MS)

  // 夸克整路最多等 QUARK_CAP_MS，超时就当没找到，交给公开源
  const quarkCand = await withCap(quarkP, QUARK_CAP_MS, () =>
    notes.push(`夸克：超过 ${QUARK_CAP_MS}ms 还没签出来，交给公开源`)
  )
  clearTimeout(publicTimer)
  if (quarkCand) {
    // 夸克赢了：公开源要是已经启动了就把请求掐掉，别继续麻烦上游
    abortPublic()
    return done(quarkCand, false)
  }

  // 夸克没中：公开源顶上（已经在跑的就直接等结果）
  const [ne, kw] = await startPublic()
  notes.push(...ne.notes, ...kw.notes)
  for (const c of [...ne.cands, ...kw.cands]) {
    if ((await probe(c)) === 'ok') return done(c, false)
  }

  if (partialFallback) {
    notes.push('所有音源都只有试听片段，用第一个兜底')
    return done(partialFallback, true)
  }
  notes.push(`⏱ 总耗时 ${Date.now() - tAll}ms`)
  return { ok: false, notes, error: '几个音源都没找到可播放的完整版' }
}

// ------------------------------------------------------------------- 工具

/** 一路音源收集到的候选直链（只收集，不探活，探活留到主流程按优先级做） */
interface Collected {
  cands: Cand[]
  notes: string[]
}

/** 网易云：直取或搜索出候选 id，取直链 */
async function collectNetease(
  req: ResolveRequest,
  kws: string[],
  signal?: AbortSignal
): Promise<Collected> {
  const cands: Cand[] = []
  const notes: string[] = []
  const ids: string[] = []
  const tSearch = Date.now()
  if (req.platformId) {
    ids.push(req.platformId)
  } else if (kws[0]) {
    let d: any = null
    try {
      d = await getJson<any>(
        `${NETEASE}/api/search/get?s=${enc(kws[0])}&type=1&limit=25&offset=0`,
        NE_HEADERS,
        9000,
        signal
      )
    } catch (e) {
      notes.push(`网易云搜索失败：${errMsg(e)}`)
    }
    const songs: any[] = d?.result?.songs ?? []
    ids.push(
      ...songs
        .filter((s) => sameTitle(String(s.name ?? ''), req.title))
        .slice(0, 2)
        .map((s) => String(s.id))
    )
    notes.push(
      `网易云：搜索「${kws[0]}」${Date.now() - tSearch}ms，返回 ${songs.length} 条，同名 ${ids.length} 条`
    )
  }
  const tDirect = Date.now()
  for (const id of ids.slice(0, 3)) {
    const u = await neteaseDirect(id, signal)
    if (!u) {
      notes.push(`网易云 ${id}：平台没有版权 / 直链探测失败`)
      continue
    }
    cands.push({
      url: u,
      source: '网易云',
      ref: `${NETEASE}/`,
      ua: UA_NETEASE,
      title: req.title,
      total: 0,
    })
  }
  if (ids.length) notes.push(`网易云：取直链 ${Date.now() - tDirect}ms，拿到 ${cands.length} 条`)
  return { cands, notes }
}

/** 酷我：搜索 → 转码，取直链 */
async function collectKuwo(
  req: ResolveRequest,
  kws: string[],
  signal?: AbortSignal
): Promise<Collected> {
  const cands: Cand[] = []
  const notes: string[] = []
  if (!kws[0]) return { cands, notes }
  const tSearch = Date.now()
  let text = ''
  try {
    text = await getText(kuwoSearchUrl(kws[0]), KW_HEADERS, 9000, signal)
  } catch (e) {
    notes.push(`酷我搜索失败：${errMsg(e)}`)
  }
  const rids: string[] = []
  for (const chunk of text.split('},{')) {
    if (field(chunk, 'ONLINE') !== '1') continue
    if (!/MP3/i.test(field(chunk, 'FORMATS') ?? '')) continue
    const rid = field(chunk, 'DC_TARGETID')
    if (rid) rids.push(rid)
    if (rids.length >= 2) break
  }
  notes.push(`酷我：搜索「${kws[0]}」${Date.now() - tSearch}ms，拿到 ${rids.length} 个可播 rid`)
  const tDirect = Date.now()
  for (const rid of rids) {
    const t = await getText(
      `${KUWO_ANTI}/anti.s?type=convert_url&format=mp3&rid=${rid}&br=128&response=url`,
      KW_HEADERS,
      9000,
      signal
    ).catch(() => '')
    const m = /https?:\/\/[^\s'"<>]+\.(mp3|aac|flac)/i.exec(t)
    if (!m) {
      notes.push(`酷我 ${rid}：拿不到直链`)
      continue
    }
    cands.push({
      url: https(m[0]),
      source: '酷我',
      ref: `${KUWO_SEARCH}/`,
      ua: UA_PC,
      title: req.title,
      total: 0,
    })
  }
  if (rids.length) notes.push(`酷我：取直链 ${Date.now() - tDirect}ms，拿到 ${cands.length} 条`)
  return { cands, notes }
}

interface LmyHit {
  id: string
  title: string
  artist: string
}

async function lmySearch(kw: string): Promise<LmyHit[]> {
  if (!kw) return []
  const d = await getJson<any>(`${LMY}/api/music/search?q=${enc(kw)}`, LMY_HEADERS).catch(
    () => null
  )
  return (d?.data ?? []).map((o: any) => ({
    id: String(o.id ?? ''),
    title: String(o.title ?? '').trim(),
    artist: String(o.artist ?? '').trim(),
  })).filter((h: LmyHit) => h.id && h.title)
}

async function lmyDetail(
  id: string
): Promise<{ downloads: Array<{ url: string; quality: string }> } | null> {
  const d = await getJson<any>(`${LMY}/api/music/${enc(id)}`, LMY_HEADERS).catch(() => null)
  if (!d) return null
  return {
    downloads: (d.downloads ?? []).map((o: any) => ({
      url: String(o.url ?? ''),
      quality: String(o.quality ?? ''),
    })),
  }
}

/**
 * 下歌吧 id → 夸克分享链接。
 * 分享链接是死的（同一首歌永远是那一份网盘资源），缓存起来能省掉一次详情往返（~380ms）。
 */
const LMY_SHARE_TTL = 6 * 60 * 60 * 1000
const LMY_SHARE_NULL_TTL = 10 * 60 * 1000
const LMY_SHARE_MAX = 500
const lmyShareCache = new Map<string, { url: string | null; at: number }>()

async function lmyShareOf(id: string): Promise<string | null> {
  const hit = lmyShareCache.get(id)
  if (hit) {
    const ttl = hit.url ? LMY_SHARE_TTL : LMY_SHARE_NULL_TTL
    if (Date.now() - hit.at < ttl) return hit.url
  }
  const detail = await lmyDetail(id)
  if (!detail) return null
  const share = detail.downloads
    .filter((x) => /pan\.quark\.cn\/s\//.test(x.url))
    .sort((a, b) => qualityRank(b.quality) - qualityRank(a.quality))[0]
  const url = share?.url ?? null
  if (lmyShareCache.size >= LMY_SHARE_MAX) {
    let oldestKey = ''
    let oldestAt = Infinity
    for (const [k, v] of lmyShareCache) {
      if (v.at < oldestAt) {
        oldestAt = v.at
        oldestKey = k
      }
    }
    if (oldestKey) lmyShareCache.delete(oldestKey)
  }
  lmyShareCache.set(id, { url, at: Date.now() })
  return url
}

/** 下歌吧 id → 夸克直链候选（分享链接 → 签发直链）。 */
async function quarkCandById(id: string, cookie: string): Promise<Cand | null> {
  const share = await lmyShareOf(id)
  if (!share) return null
  const q = await quarkDirect(share, cookie).catch(() => null)
  if (!q) return null
  return {
    url: q.url,
    source: '夸克',
    ref: QUARK_REFERER,
    ua: UA_PC,
    cookie: q.cookie,
    title: '',
    fileName: q.fileName,
    total: q.size,
  }
}

function qualityRank(q: string): number {
  if (/FLAC/i.test(q)) return 5
  if (/WAV/i.test(q)) return 4
  if (/MP3/i.test(q)) return 3
  if (/百度/i.test(q)) return 2
  return 1
}

async function neteaseDirect(songId: string, signal?: AbortSignal): Promise<string | null> {
  const r = await http(
    `${NETEASE}/song/media/outer/url?id=${songId}.mp3`,
    { headers: NE_HEADERS, redirect: 'manual', signal }
  ).catch(() => null)
  const loc = r?.headers.get('location')
  if (!loc || loc.includes('/404')) return null
  try {
    return https(new URL(loc, NETEASE).toString())
  } catch {
    return null
  }
}

/**
 * 夸克：签发直链时就知道文件多大，直接判是不是 30 秒试听片段，
 * 不用再发一次探活请求（省 ~180ms）。
 */
function quarkIsPartial(size: number, durationSec: number): boolean {
  if (size <= 0) return false
  if (bytesLookPartial(size, durationSec)) return true
  return durationSec <= 0 && size < ABSOLUTE_PARTIAL_MAX_SEC * BYTES_PER_SEC
}

/** 给一条链路加时间上限：超时按「没结果」处理，别一直挂着。 */
function withCap<T>(p: Promise<T>, ms: number, onTimeout: () => void): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      onTimeout()
      resolve(null)
    }, ms)
    p.then(
      (v) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(v)
      },
      () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(null)
      }
    )
  })
}

function kuwoSearchUrl(kw: string): string {
  return (
    `${KUWO_SEARCH}/r.s?all=${enc(kw)}&ft=music&itemset=web_2013&client=kt` +
    `&pn=0&rn=20&rformat=json&encoding=utf8`
  )
}

/** 酷我老接口返回的是 Python dict 文本，不是 JSON，用宽松正则抠字段。 */
function field(chunk: string, name: string): string | null {
  const m = new RegExp(`['"]?${name}['"]?\\s*:\\s*['"]([^'"]*)['"]`).exec(chunk)
  return m ? m[1] : null
}
