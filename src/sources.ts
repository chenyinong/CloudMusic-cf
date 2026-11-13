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
import { ABSOLUTE_PARTIAL_MAX_SEC, artistHit, artistMatch, isVariant, keywords, sameTitle, titleLoose, tooShort } from './match'
import { quarkDirect, verifyQuarkCookie } from './quark'

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
/** 夸克多久没进展就放弃（CF 边缘到国内音源的往返比本机慢，不能用死定时器砍） */
const QUARK_STALL_MS = 5000
/** 夸克整路总上限，防止一直挂着 */
const QUARK_TOTAL_MS = 12000

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
  /** 音源报出来的真实时长（秒），0 = 不知道 */
  durationSec?: number
  /** 歌手跟要的不是一个（降级时用了别的歌手的版本） */
  mismatch?: boolean
}

/** 夸克命中结果：cand 是直链，mismatch 表示这不是原唱（别的歌手的版本） */
interface QuarkHit {
  cand: Cand
  mismatch: boolean
}

export interface ResolveResult {
  ok: boolean
  resolved?: Resolved
  notes: string[]
  error?: string
}

/**
 * 解析结果缓存：同一首歌反复切（列表来回点、上一首下一首）时，30 分钟内
 * 直接复用上次的结果，避免每次都重新搜源 + 签发令牌。
 * 这是 Worker 实例内存缓存，冷启动/多实例之间不共享，但已经能吃掉绝大部分重复解析。
 */
const RESOLVE_TTL = 30 * 60 * 1000
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
    return { ...hit.res, notes: [...hit.res.notes, '命中解析缓存（30 分钟内复用上次结果）'] }
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

  const done = async (
    c: Cand,
    partial: boolean,
    mismatch = false,
    fallback = ''
  ): Promise<ResolveResult> => {
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
      mismatch: mismatch || undefined,
      fallback: fallback || undefined,
    }
    // 复制一份：夸克超时的尾巴还可能往 notes 里追加，别污染缓存里的结果
    return { ok: true, resolved, notes: [...notes] }
  }

  // ── 夸克优先 ──────────────────────────────────────────────────────────
  /** 夸克最后一次有进展的时间：卡住太久就交给公开源，进展中就一直等 */
  let quarkAt = Date.now()
  /** 当前有几个夸克请求在飞：在飞的时候不算「没进展」 */
  let quarkBusy = 0
  const touchQuark = () => {
    quarkAt = Date.now()
  }
  /**
   * 包一层夸克请求。
   *
   * 「5 秒没进展就放弃」这个判断，必须把「正在等一个请求」和「真的卡住」分开：
   * 下歌吧偶尔会慢到 5 秒以上（CF 边缘到国内音源），那时候其实是有进展的，
   * 只是还没回来 —— 不然一慢就把整条夸克路判死，
   * 「网盘里明明有这首歌」又会变成「夸克没找到」。
   */
  const busy = async <T>(fn: () => Promise<T>): Promise<T> => {
    quarkBusy++
    touchQuark()
    try {
      return await fn()
    } finally {
      quarkBusy--
      touchQuark()
    }
  }
  /** 夸克候选：签发直链 + 用签发时带回来的真实时长/文件大小判是不是试听片段。 */
  const quarkSign = async (h: LmyHit): Promise<Cand | null> => {
    const t0 = Date.now()
    touchQuark()
    let c: Cand | null = null
    try {
      c = await busy(() => quarkCandById(h.id, cookie, touchQuark, !req.prefetch))
    } catch (e) {
      notes.push(`夸克「${h.title}」签发失败（${errMsg(e)}，${Date.now() - t0}ms）`)
      touchQuark()
      return null
    }
    if (!c) {
      notes.push(`夸克「${h.title}」拿不到直链（${Date.now() - t0}ms）`)
      touchQuark()
      return null
    }
    c.title = h.title
    const mb = (c.total / 1048576).toFixed(1)
    const fname = c.fileName ? `「${c.fileName}」` : ''
    if (quarkIsPartial(c.total, c.durationSec ?? 0, req.durationSec)) {
      notes.push(`夸克「${h.title}」${fname}只有试听片段（${mb}MB，${Date.now() - t0}ms），继续找完整版`)
      partialFallback ??= c
      touchQuark()
      return null
    }
    notes.push(`夸克「${h.title}」${fname}拿到完整版（${mb}MB，${Date.now() - t0}ms）`)
    touchQuark()
    return c
  }

  const quarkP = (async (): Promise<QuarkHit | null> => {
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
      const c = await quarkCandById(req.quarkId, cookie, undefined, !req.prefetch).catch(() => null)
      touchQuark()
      if (!c) {
        notes.push('夸克：指定的网盘资源不可用，改走搜索')
      } else {
        c.title = req.title
        const mb = (c.total / 1048576).toFixed(1)
        if (quarkIsPartial(c.total, c.durationSec ?? 0, req.durationSec)) {
          notes.push(`夸克：指定资源只有试听片段（${mb}MB），改走搜索`)
        } else {
          notes.push(`夸克：指定资源「${c.fileName}」拿到完整版（${mb}MB）`)
          return { cand: c, mismatch: false }
        }
      }
    }
    // ── 挨个关键词搜（跟安卓端一致）────────────────────────────────────
    // 关键词顺序：纯歌名 → 歌名+歌手 → 原样歌名。
    // 下歌吧对长关键词会直接 400，纯歌名反而最准，所以纯歌名排第一；
    // 但纯歌名搜不到时必须换下一个词再试 —— 只搜一个词的话，
    // 夸克网盘里明明有的歌会被判成「没找到」。
    const merged = new Map<string, LmyHit>()
    const tried = new Set<string>()
    let failedKw = 0
    for (const kw of kws) {
      if (!kw) continue
      let hits: LmyHit[] = []
      try {
        hits = await busy(() => lmySearch(kw))
      } catch (e) {
        // 一个词炸了不能把整条路拖死，后面的词还得试
        failedKw++
        notes.push(`下歌吧：关键词「${kw}」搜索失败（${errMsg(e)}）`)
        touchQuark()
        continue
      }
      touchQuark()
      for (const h of hits) if (!merged.has(h.id)) merged.set(h.id, h)
      notes.push(`下歌吧：关键词「${kw}」搜到 ${hits.length} 条（累计 ${merged.size} 条）`)

      // 候选：歌名沾边 + 有夸克资源 + 原唱优先
      let pool = pickQuarkCandidates(merged, req, tried)

      // 这一页没有原唱 → 往后翻一页找（原唱常常排在 20 条之后，
      // 只看第一页会把「网盘里明明有原唱」的歌判成没有）
      if (!pool.some((h) => artistHit(req.artist, h.artist))) {
        try {
          const more = await busy(() => lmySearch(kw, 2))
          touchQuark()
          if (more.length) {
            for (const h of more) if (!merged.has(h.id)) merged.set(h.id, h)
            notes.push(`下歌吧：关键词「${kw}」第 2 页又搜到 ${more.length} 条（累计 ${merged.size} 条）`)
            pool = pickQuarkCandidates(merged, req, tried)
          }
        } catch (e) {
          notes.push(`下歌吧：关键词「${kw}」第 2 页搜索失败（${errMsg(e)}）`)
          touchQuark()
        }
      }
      if (!pool.length) continue

      const tCand = Date.now()
      // 先签第一个：中了就收工，省掉另外几个候选的签发往返；
      // 不中再把剩下的并行签，别一个个排队等
      const signPool = async (
        list: LmyHit[]
      ): Promise<{ cand: Cand; hit: LmyHit } | null> => {
        if (!list.length) return null
        const first = await quarkSign(list[0])
        if (first) return { cand: first, hit: list[0] }
        const rest = await Promise.all(
          list.slice(1).map(async (h) => ({ cand: await quarkSign(h), hit: h }))
        )
        const ok = rest.find((r) => !!r.cand)
        return ok && ok.cand ? { cand: ok.cand, hit: ok.hit } : null
      }
      const signed = await signPool(pool)
      for (const h of pool) tried.add(h.id)
      notes.push(`下歌吧：候选签发共 ${Date.now() - tCand}ms`)
      if (signed) {
        // 命中的这条歌手跟要的不一样 → 这是别的歌手的版本，要标出来
        const mismatch = !artistHit(req.artist, signed.hit.artist)
        if (mismatch) notes.push('下歌吧里没有这首歌原唱的资源，这个是别的歌手的版本')
        return { cand: signed.cand, mismatch }
      }
      // 这个关键词下的候选都不行 → 换下一个关键词继续试
    }
    if (failedKw) notes.push(`下歌吧：${failedKw} 个关键词搜索失败`)
    return null
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
            { cands: [], loose: [], notes: [] },
            { cands: [], loose: [], notes: [] },
          ] as [Collected, Collected]
      )
    }
    return publicP
  }

  const publicTimer = setTimeout(() => {
    void startPublic()
  }, PUBLIC_DELAY_MS)

  // 夸克整路：卡住太久或超时就当没找到，交给公开源（进展中就一直等）
  const quarkHit = await withProgressCap(
    quarkP,
    QUARK_STALL_MS,
    QUARK_TOTAL_MS,
    () => quarkAt,
    () => quarkBusy > 0,
    (why) => notes.push(`夸克：${why}（${QUARK_STALL_MS}ms 没进展），交给公开源`)
  )
  clearTimeout(publicTimer)
  if (quarkHit) {
    // 夸克赢了：公开源要是已经启动了就把请求掐掉，别继续麻烦上游
    abortPublic()
    return done(quarkHit.cand, false, quarkHit.mismatch)
  }

  // 夸克没中：公开源顶上（已经在跑的就直接等结果）
  const [ne, kw] = await startPublic()
  notes.push(...ne.notes, ...kw.notes)
  // 明明登录了夸克却没走夸克，把原因告诉前端（别让人以为是没登录）
  const fallback = await quarkFallbackReason(req, cookie)
  for (const c of [...ne.cands, ...kw.cands]) {
    if ((await probe(c)) === 'ok') return done(c, false, false, fallback)
  }
  // 公开源里没有原唱：只能拿翻唱顶上，明确标出来，别让人以为是原唱
  for (const c of [...ne.loose, ...kw.loose]) {
    if ((await probe(c)) === 'ok') {
      notes.push('公开源里没有这首歌的原唱版本，这个是别的歌手的版本')
      return done(c, false, true, fallback)
    }
  }

  // partialFallback 是在闭包里赋值的，TS 这里推不出来，断言一下类型
  const fb = partialFallback as Cand | null
  if (fb) {
    notes.push('所有音源都只有试听片段，用第一个兜底')
    return done(fb, true, !!fb.mismatch, fallback)
  }
  notes.push(`⏱ 总耗时 ${Date.now() - tAll}ms`)
  return { ok: false, notes, error: '几个音源都没找到可播放的完整版' }
}

// ------------------------------------------------------------------- 工具

/** 一路音源收集到的候选直链（只收集，不探活，探活留到主流程按优先级做） */
interface Collected {
  /** 歌手对得上的（优先用） */
  cands: Cand[]
  /** 歌名对得上但歌手对不上（没有原唱时的降级选项，要标出来） */
  loose: Cand[]
  notes: string[]
}

/** 网易云搜索结果里的歌手名 */
function neteaseArtists(song: any): string[] {
  const out: string[] = []
  for (const a of song?.artists ?? []) {
    const n = String(a?.name ?? '').trim()
    if (n) out.push(n)
  }
  for (const a of song?.alias ?? []) {
    const n = String(a?.name ?? '').trim()
    if (n) out.push(n)
  }
  return out
}

/** 网易云：直取或搜索出候选 id，取直链 */
async function collectNetease(
  req: ResolveRequest,
  kws: string[],
  signal?: AbortSignal
): Promise<Collected> {
  const cands: Cand[] = []
  const loose: Cand[] = []
  const notes: string[] = []
  const ids: string[] = []
  const looseIds: string[] = []
  const tSearch = Date.now()
  if (req.platformId) {
    // 歌单自带的平台 id，本来就是平台上的那一条，直接用
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
    // 歌名一样的，再看是不是衍生版本（伴奏/DJ版/翻唱…），最后比歌手
    const same = songs.filter((s) => sameTitle(String(s.name ?? ''), req.title))
    const plain = same.filter((s) => !isVariant(String(s.name ?? ''), neteaseArtists(s)[0] ?? ''))
    const strict = plain.filter((s) => artistMatch(req.artist, neteaseArtists(s)))
    const other = plain.filter((s) => !strict.includes(s))
    ids.push(
      ...strict
        .slice(0, 2)
        .map((s) => String(s.id))
    )
    looseIds.push(
      ...other
        .slice(0, 2)
        .map((s) => String(s.id))
    )
    notes.push(
      `网易云：搜索「${kws[0]}」${Date.now() - tSearch}ms，返回 ${songs.length} 条，` +
        `同名 ${same.length} 条、歌手对得上 ${strict.length} 条`
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
  for (const id of looseIds.slice(0, 2)) {
    const u = await neteaseDirect(id, signal)
    if (!u) continue
    loose.push({
      url: u,
      source: '网易云',
      ref: `${NETEASE}/`,
      ua: UA_NETEASE,
      title: req.title,
      total: 0,
    })
  }
  if (ids.length) notes.push(`网易云：取直链 ${Date.now() - tDirect}ms，拿到 ${cands.length} 条`)
  return { cands, loose, notes }
}

/** 酷我：搜索 → 转码，取直链 */
async function collectKuwo(
  req: ResolveRequest,
  kws: string[],
  signal?: AbortSignal
): Promise<Collected> {
  const cands: Cand[] = []
  const loose: Cand[] = []
  const notes: string[] = []
  if (!kws[0]) return { cands, loose, notes }
  const tSearch = Date.now()
  let text = ''
  try {
    text = await getText(kuwoSearchUrl(kws[0]), KW_HEADERS, 9000, signal)
  } catch (e) {
    notes.push(`酷我搜索失败：${errMsg(e)}`)
  }
  const rids: string[] = []
  const looseRids: string[] = []
  let skipped = 0
  for (const chunk of text.split('},{')) {
    if (field(chunk, 'ONLINE') !== '1') continue
    if (!/MP3/i.test(field(chunk, 'FORMATS') ?? '')) continue
    const name = decodeEntities(field(chunk, 'SONGNAME') ?? '')
    const artist = decodeEntities(field(chunk, 'ARTIST') ?? '')
    // 歌名必须一样（原来根本不比歌名，搜到什么拿什么）
    if (!sameTitle(name, req.title)) {
      skipped++
      continue
    }
    if (isVariant(name, artist)) {
      skipped++
      continue
    }
    const rid = field(chunk, 'DC_TARGETID')
    if (!rid) continue
    if (artistMatch(req.artist, [artist])) {
      rids.push(rid)
      if (rids.length >= 2) break
    } else {
      // 歌手对不上的先存着，别急着停 —— 原唱可能排在后面
      // （最多存 3 个：每个都要探活一次，多了纯属拖慢响应）
      if (looseRids.length < 3) looseRids.push(rid)
    }
  }
  notes.push(
    `酷我：搜索「${kws[0]}」${Date.now() - tSearch}ms，歌手对得上 ${rids.length} 个可播 rid` +
      (skipped ? `，跳过 ${skipped} 个歌名/版本不对的` : '')
  )
  const tDirect = Date.now()
  for (const rid of rids) {
    const u = await kuwoDirect(rid, signal)
    if (!u) {
      notes.push(`酷我 ${rid}：拿不到直链`)
      continue
    }
    cands.push({
      url: u,
      source: '酷我',
      ref: `${KUWO_SEARCH}/`,
      ua: UA_PC,
      title: req.title,
      total: 0,
    })
  }
  for (const rid of looseRids) {
    const u = await kuwoDirect(rid, signal)
    if (!u) continue
    loose.push({
      url: u,
      source: '酷我',
      ref: `${KUWO_SEARCH}/`,
      ua: UA_PC,
      title: req.title,
      total: 0,
    })
  }
  if (rids.length) notes.push(`酷我：取直链 ${Date.now() - tDirect}ms，拿到 ${cands.length} 条`)
  return { cands, loose, notes }
}

/** 酷我：rid → 直链 */
async function kuwoDirect(rid: string, signal?: AbortSignal): Promise<string | null> {
  const t = await getText(
    `${KUWO_ANTI}/anti.s?type=convert_url&format=mp3&rid=${rid}&br=128&response=url`,
    KW_HEADERS,
    9000,
    signal
  ).catch(() => '')
  const m = /https?:\/\/[^\s'"<>]+\.(mp3|aac|flac)/i.exec(t)
  return m ? https(m[0]) : null
}

interface LmyHit {
  id: string
  title: string
  artist: string
  /** 音质列表，如 ["夸克MP3","夸克FLAC"]。带「夸克」的才有网盘分享 */
  quality: string[]
}

/** 这条搜索结果有没有夸克网盘资源（quality 没写就当有，别误杀） */
function hitHasQuark(h: LmyHit): boolean {
  if (!h.quality.length) return true
  return h.quality.some((q) => /夸克/.test(q))
}

/**
 * 从合并后的搜索结果里挑值得签的候选。
 *
 * 顺序：歌名完全一样 > 歌名沾边；原唱 > 别的歌手的版本；非衍生版本 > 伴奏/DJ/翻唱；
 * 音质高的靠前。签一个夸克直链要三个请求，挑错歌既慢又难听。
 */
function pickQuarkCandidates(
  merged: Map<string, LmyHit>,
  req: ResolveRequest,
  tried: Set<string>
): LmyHit[] {
  const all = [...merged.values()].filter((h) => !tried.has(h.id))
  // 歌名必须沾边：根本不是这首歌的别去签
  const titled = all.filter((h) => titleLoose(h.title, req.title))
  if (!titled.length) return []
  // 有夸克网盘资源的排前面（一个都没有的话这条歌本来就下不了）
  const withQ = titled.filter(hitHasQuark)
  const pool = withQ.length ? withQ : titled
  return pool
    .slice()
    .sort((a, b) => {
      const t = Number(sameTitle(b.title, req.title)) - Number(sameTitle(a.title, req.title))
      if (t) return t
      const s = Number(artistHit(req.artist, b.artist)) - Number(artistHit(req.artist, a.artist))
      if (s) return s
      const v = Number(isVariant(a.title, a.artist)) - Number(isVariant(b.title, b.artist))
      if (v) return v
      return hitQualityRank(b) - hitQualityRank(a)
    })
    .slice(0, 4)
}

/** 搜索结果自带的音质排序（FLAC > WAV > MP3）。 */
function hitQualityRank(h: LmyHit): number {
  let best = 0
  for (const q of h.quality) best = Math.max(best, qualityRank(q))
  return best
}

/**
 * 明明登录了夸克却没走夸克 —— 给前端一句人话。
 *
 * Cookie 失效时长得跟「网盘里没这首歌」一模一样（都是签不出直链），
 * 先验一下登录态，别让人以为歌真的没有。
 */
async function quarkFallbackReason(req: ResolveRequest, cookie: string): Promise<string> {
  if (req.skipQuark) return '夸克直链失效'
  if (!cookie) return ''
  const v = await verifyQuarkCookie(cookie).catch(() => ({ valid: null as boolean | null }))
  if (v.valid === false) return '夸克登录已失效，重新登录试试'
  return '夸克没找到这首歌'
}

async function lmySearch(kw: string, page = 1): Promise<LmyHit[]> {
  if (!kw) return []
  // 失败要往上抛：外层按关键词兜异常，一个词炸了不能把整条路拖死
  const d = await getJson<any>(
    `${LMY}/api/music/search?q=${enc(kw)}${page > 1 ? `&page=${page}` : ''}`,
    LMY_HEADERS
  )
  return (d?.data ?? [])
    .map((o: any) => ({
      id: String(o.id ?? ''),
      title: String(o.title ?? '').trim(),
      artist: String(o.artist ?? '').trim(),
      quality: (Array.isArray(o.quality) ? o.quality : [o.quality ?? ''])
        .map((q: any) => String(q ?? '').trim())
        .filter((q: string) => !!q),
    }))
    .filter((h: LmyHit) => h.id && h.title)
}

async function lmyDetail(
  id: string
): Promise<{ downloads: Array<{ url: string; quality: string }> } | null> {
  const d = await getJson<any>(`${LMY}/api/music/${enc(id)}`, LMY_HEADERS)
  if (!d) return null
  return {
    downloads: (d.downloads ?? []).map((o: any) => ({
      url: String(o.url ?? ''),
      quality: String(o.quality ?? ''),
    })),
  }
}

/**
 * 下歌吧 id → 这首歌的所有夸克分享（按音质从高到低）。
 *
 * 一条歌可能有多个分享（MP3 / FLAC / WAV），挨个试才对 ——
 * 第一个分享失效（文件是数字、分享过期）不能就此放弃，否则整首歌被判死。
 * 分享链接是死的（同一首歌永远是那一份网盘资源），缓存 6 小时省一次详情往返。
 */
const LMY_SHARE_TTL = 6 * 60 * 60 * 1000
const LMY_SHARE_NULL_TTL = 10 * 60 * 1000
const LMY_SHARE_MAX = 500
const lmyShareCache = new Map<string, { urls: string[]; at: number }>()

async function lmySharesOf(id: string): Promise<string[]> {
  const hit = lmyShareCache.get(id)
  if (hit) {
    const ttl = hit.urls.length ? LMY_SHARE_TTL : LMY_SHARE_NULL_TTL
    if (Date.now() - hit.at < ttl) return hit.urls
  }
  const detail = await lmyDetail(id)
  if (!detail) return []
  const urls = detail.downloads
    .filter((x) => /pan\.quark\.cn\/s\//.test(x.url))
    .sort((a, b) => qualityRank(b.quality) - qualityRank(a.quality))
    .map((x) => x.url)
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
  lmyShareCache.set(id, { urls, at: Date.now() })
  return urls
}

/** 下歌吧 id → 夸克直链候选（挨个分享试，签出直链就算成功）。 */
async function quarkCandById(
  id: string,
  cookie: string,
  onProgress?: () => void,
  probe = true
): Promise<Cand | null> {
  const shares = await lmySharesOf(id)
  if (!shares.length) return null
  for (const share of shares) {
    const q = await quarkDirect(share, cookie, onProgress, probe).catch(() => null)
    if (!q) continue
    return {
      url: q.url,
      source: '夸克',
      ref: QUARK_REFERER,
      ua: UA_PC,
      cookie: q.cookie,
      title: '',
      fileName: q.fileName,
      total: q.size,
      durationSec: q.durationSec,
    }
  }
  return null
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
 * 夸克：签发直链时就知道文件多大、真实时长多少，直接判是不是试听片段，
 * 不用再发一次探活请求（省 ~180ms）。
 *
 * 有真实时长就按真实时长判（跟安卓端 tooShort 一个口径：短 40% 以上算片段），
 * 别拿字节数瞎猜 —— 歌单里的时长不准时会把完整版误判成片段，
 * 误判的后果是这首歌「明明网盘里有」却被判成没找到。
 */
function quarkIsPartial(size: number, realSec: number, durationSec: number): boolean {
  if (realSec > 0) {
    if (durationSec > 0) return tooShort(realSec, durationSec)
    return realSec <= ABSOLUTE_PARTIAL_MAX_SEC
  }
  if (size <= 0) return false
  if (bytesLookPartial(size, durationSec)) return true
  return durationSec <= 0 && size < ABSOLUTE_PARTIAL_MAX_SEC * BYTES_PER_SEC
}

/**
 * 夸克整路的上限：
 *   · stallMs —— 多久没有任何进展就放弃（夸克还在慢慢跑就一直等，不误伤慢链路）
 *   · totalMs —— 整条路最多等多久（兜底，防止一直挂着）
 *
 * 有请求在飞的时候不看 stallMs —— 慢请求不是「卡住」，
 * 否则下歌吧偶尔慢 5 秒就会把整条夸克路判死。
 */
function withProgressCap<T>(
  p: Promise<T>,
  stallMs: number,
  totalMs: number,
  lastProgress: () => number,
  isBusy: () => boolean,
  onTimeout: (why: string) => void
): Promise<T | null> {
  const t0 = Date.now()
  return new Promise<T | null>((resolve) => {
    let settled = false
    const timer = setInterval(() => {
      if (settled) return
      const stalled = !isBusy() && Date.now() - lastProgress() > stallMs
      const over = Date.now() - t0 > totalMs
      if (!stalled && !over) return
      settled = true
      clearInterval(timer)
      onTimeout(stalled ? '卡住了' : '超时')
      resolve(null)
    }, 400)
    p.then(
      (v) => {
        if (settled) return
        settled = true
        clearInterval(timer)
        resolve(v)
      },
      () => {
        if (settled) return
        settled = true
        clearInterval(timer)
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

/**
 * 酷我老接口返回的是 Python dict 文本，不是 JSON，用宽松正则抠字段。
 *
 * 字段名必须带引号一起匹配：不然 'HIT_BUT_OFFLINE' 会被当成 'ONLINE'、
 * 'AARTIST' 会被当成 'ARTIST'，抠出来的值全错。
 */
function field(chunk: string, name: string): string | null {
  const m = new RegExp(`'${name}'\\s*:\\s*'([^']*)'`).exec(chunk)
  return m ? m[1] : null
}

/** 酷我返回的文本里带 &nbsp; 之类的实体，先还原再比歌名。 */
function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim()
}
