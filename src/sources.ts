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
    Math.round(req.durationSec || 0),
    ck ? String(ckHash) : '',
  ].join('|')
}

export async function resolveTrack(req: ResolveRequest, secret: string): Promise<ResolveResult> {
  const key = resolveCacheKey(req)
  const hit = resolveCache.get(key)
  if (hit && Date.now() - hit.at < RESOLVE_TTL) {
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
  const cookie = (req.cookie ?? '').trim()
  const kws = keywords(req.title, req.artist)
  let partialFallback: Cand | null = null

  /** 探活 + 片段判定。片段留作兜底，继续找完整版。 */
  async function probe(c: Cand): Promise<'ok' | 'partial' | 'dead'> {
    const h: Record<string, string> = { 'User-Agent': c.ua, Referer: c.ref }
    if (c.cookie) h.Cookie = c.cookie
    let p: { ok: boolean; total: number }
    try {
      p = await probeAudio(c.url, h)
    } catch {
      notes.push(`${c.source}：探活失败`)
      return 'dead'
    }
    if (!p.ok) {
      notes.push(`${c.source}：直链读不到音频`)
      return 'dead'
    }
    c.total = p.total
    const mb = (p.total / 1048576).toFixed(1)
    const byBytes = bytesLookPartial(p.total, req.durationSec)
    const byAbsolute =
      req.durationSec <= 0 && p.total > 0 && p.total < ABSOLUTE_PARTIAL_MAX_SEC * BYTES_PER_SEC
    if (byBytes || byAbsolute) {
      notes.push(`${c.source}「${c.fileName ?? c.title}」只有试听片段（${mb}MB），继续找完整版`)
      partialFallback ??= c
      return 'partial'
    }
    notes.push(`${c.source}「${c.fileName ?? c.title}」拿到完整版（${mb}MB）`)
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
    return { ok: true, resolved, notes }
  }

  // ── 三路音源并行准备 ──────────────────────────────────────────────────
  // 原来是串行的：夸克不中才查网易云，网易云不中才查酷我，等待时间一层层叠加，
  // 点一首歌要等好几秒。改成夸克照旧先探（拿到完整版立刻返回），
  // 同时后台把网易云、酷我的候选直链准备好 —— 夸克不中时就不用再等它们了。
  const quarkP = (async () => {
    if (!cookie) {
      notes.push('夸克：未填 Cookie，跳过（只用公开源）')
      return null
    }
    const hits = await lmySearch(kws[0] ?? '')
    notes.push(`下歌吧：搜到 ${hits.length} 条`)
    const same = hits.filter((h) => sameTitle(h.title, req.title))
    const ordered = (same.length ? same : hits).sort(
      (a, b) => Number(artistHit(req.artist, b.artist)) - Number(artistHit(req.artist, a.artist))
    )
    // 三个候选并行签发 + 探活：原来是一个不行再试下一个，等待时间三倍叠加
    const cands = await Promise.all(
      ordered.slice(0, 3).map(async (h) => {
        try {
          const detail = await lmyDetail(h.id)
          const share = detail.downloads
            .filter((x) => /pan\.quark\.cn\/s\//.test(x.url))
            .sort((a, b) => qualityRank(b.quality) - qualityRank(a.quality))[0]
          if (!share) return null
          const q = await quarkDirect(share.url, cookie).catch(() => null)
          if (!q) {
            notes.push(`夸克「${h.title}」直链签发失败`)
            return null
          }
          const c: Cand = {
            url: q.url,
            source: '夸克',
            ref: QUARK_REFERER,
            ua: UA_PC,
            cookie: q.cookie,
            title: h.title,
            fileName: q.fileName,
            total: q.size,
          }
          return (await probe(c)) === 'ok' ? c : null
        } catch {
          return null
        }
      })
    )
    return cands.find((c): c is Cand => !!c) ?? null
  })()

  // 这两路同时在后台跑
  const neP = collectNetease(req, kws)
  const kwP = collectKuwo(req, kws)

  // 夸克先出结果就先用（和原来一样快）
  const quarkCand = await quarkP
  if (quarkCand) return done(quarkCand, false)

  // 夸克没戏时，另外两路早就在跑了，这会儿直接探活
  const [ne, kw] = await Promise.all([neP, kwP])
  notes.push(...ne.notes, ...kw.notes)
  for (const c of [...ne.cands, ...kw.cands]) {
    if ((await probe(c)) === 'ok') return done(c, false)
  }

  if (partialFallback) {
    notes.push('所有音源都只有试听片段，用第一个兜底')
    return done(partialFallback, true)
  }
  return { ok: false, notes, error: '几个音源都没找到可播放的完整版' }
}

// ------------------------------------------------------------------- 工具

/** 一路音源收集到的候选直链（只收集，不探活，探活留到主流程按优先级做） */
interface Collected {
  cands: Cand[]
  notes: string[]
}

/** 网易云：直取或搜索出候选 id，取直链 */
async function collectNetease(req: ResolveRequest, kws: string[]): Promise<Collected> {
  const cands: Cand[] = []
  const notes: string[] = []
  const ids: string[] = []
  if (req.platformId) {
    ids.push(req.platformId)
  } else if (kws[0]) {
    const d = await getJson<any>(
      `${NETEASE}/api/search/get?s=${enc(kws[0])}&type=1&limit=25&offset=0`,
      NE_HEADERS
    ).catch(() => null)
    const songs: any[] = d?.result?.songs ?? []
    ids.push(
      ...songs
        .filter((s) => sameTitle(String(s.name ?? ''), req.title))
        .slice(0, 2)
        .map((s) => String(s.id))
    )
  }
  for (const id of ids.slice(0, 3)) {
    const u = await neteaseDirect(id)
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
  return { cands, notes }
}

/** 酷我：搜索 → 转码，取直链 */
async function collectKuwo(req: ResolveRequest, kws: string[]): Promise<Collected> {
  const cands: Cand[] = []
  const notes: string[] = []
  if (!kws[0]) return { cands, notes }
  const text = await getText(kuwoSearchUrl(kws[0]), KW_HEADERS).catch(() => '')
  const rids: string[] = []
  for (const chunk of text.split('},{')) {
    if (field(chunk, 'ONLINE') !== '1') continue
    if (!/MP3/i.test(field(chunk, 'FORMATS') ?? '')) continue
    const rid = field(chunk, 'DC_TARGETID')
    if (rid) rids.push(rid)
    if (rids.length >= 2) break
  }
  for (const rid of rids) {
    const t = await getText(
      `${KUWO_ANTI}/anti.s?type=convert_url&format=mp3&rid=${rid}&br=128&response=url`,
      KW_HEADERS
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
): Promise<{ downloads: Array<{ url: string; quality: string }> }> {
  const d = await getJson<any>(`${LMY}/api/music/${enc(id)}`, LMY_HEADERS).catch(() => null)
  return {
    downloads: (d?.downloads ?? []).map((o: any) => ({
      url: String(o.url ?? ''),
      quality: String(o.quality ?? ''),
    })),
  }
}

function qualityRank(q: string): number {
  if (/FLAC/i.test(q)) return 5
  if (/WAV/i.test(q)) return 4
  if (/MP3/i.test(q)) return 3
  if (/百度/i.test(q)) return 2
  return 1
}

async function neteaseDirect(songId: string): Promise<string | null> {
  const r = await http(
    `${NETEASE}/song/media/outer/url?id=${songId}.mp3`,
    { headers: NE_HEADERS, redirect: 'manual' }
  ).catch(() => null)
  const loc = r?.headers.get('location')
  if (!loc || loc.includes('/404')) return null
  try {
    return https(new URL(loc, NETEASE).toString())
  } catch {
    return null
  }
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
