/**
 * 歌词：跟 Android LyricsRepository 对齐 —— 「宁缺毋滥，宁可没有也不要错配」。
 *
 * 来源顺序：
 * 1) 歌单自带的来源 id 直取（QQ / 网易云）—— 最准，但网易云很多歌没版权拿不到
 * 2) QQ 音乐搜索 + 歌词 —— 在线主力。网易云的公开搜索接口现在基本靠不住
 *    （搜「稻香 周杰伦」会返回《刀马旦》这种无关结果），QQ 反而准得多
 * 3) 下歌吧 so.liumingye.cn —— 详情接口自带完整 LRC，曲库比 QQ 全，冷门歌靠它
 * 4) 酷狗 —— 兜底
 * 5) 网易云搜索 —— 最后兜底
 *
 * 匹配口径与安卓一致：
 * - 歌名清洗（去括号 / 版本尾巴 / 开头序号）后再比
 * - 打分：歌名完全相同 10 分、互相包含 6 分、公共片段 4 分；歌手完全相同 8 分、互相包含 5 分
 * - 低于阈值 10 分宁可不返回，避免张冠李戴
 * - 文件名没写版本、却搜到伴奏 / 翻唱 / Remix 的，一律丢弃
 */
import { UA_NETEASE, UA_PC, enc, getJson, getText } from './util'

const NETEASE = 'https://music.163.com'
const QQ_SEARCH = 'https://c.y.qq.com/soso/fcgi-bin/client_search_cp'
const QQ_LYRIC = 'https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg'
const QQ_REFERER = 'https://y.qq.com/'
const LMY = 'https://so.liumingye.cn'
const KUGOU_SEARCH = 'https://songsearch.kugou.com/song_search_v2'

const NE_HEADERS = { 'User-Agent': UA_NETEASE, Referer: `${NETEASE}/` }
const QQ_HEADERS = { 'User-Agent': UA_PC, Referer: QQ_REFERER }
const LMY_HEADERS = {
  'User-Agent': UA_PC,
  Accept: 'application/json, text/plain, */*',
  Referer: `${LMY}/`,
}
const KUGOU_HEADERS = { 'User-Agent': UA_PC, Referer: 'https://www.kugou.com/' }

/** 低于这个分数就不敢用，宁可没有也不要错配。 */
const MATCH_THRESHOLD = 10

const BRACKETS = /[（(【\[][^）)】\]]*[）)】\]]/g
const VERSION_TAIL =
  /(?:\s+|^)(?:live|remix|demo|acoustic|instrumental|karaoke|dj|现场|重制|翻唱|伴奏|纯音乐|版).*$/i
const LEADING_NO = /^\s*\d{1,3}[\s.\-_]+/
const BAD_VERSION = /伴奏|纯音乐|试听|铃声|片段|翻唱|remix|instrumental|karaoke|demo/i
const VERSION_TAG = /live|现场|演唱会|remix|混音|伴奏|纯音乐|翻唱|acoustic|demo|karaoke|不插电|dj/gi
const SPACES = /\s+/g

interface QqSong {
  mid: string
  name: string
  artists: string[]
}

interface LmyHit {
  id: string
  title: string
  artist: string
}

export interface LyricResult {
  lyric: string | null
  source?: string
  error?: string
  /** 歌词没有时间轴（纯文本），由前端按歌曲时长估算时间点 */
  plain?: boolean
}

export async function fetchLyric(
  title: string,
  artist: string,
  platform?: string,
  platformId?: string
): Promise<LyricResult> {
  const errs: string[] = []
  const rawTitle = (title ?? '').trim()
  const clean = cleanTitle(rawTitle) || rawTitle
  const a = cleanArtist(artist ?? '')
  const wantTitle = normalize(clean)
  const wantArtist = normalize(a)

  // 1) 歌单自带 id 直取，最精准
  if (platform === 'qq' && platformId) {
    const qq = await fetchQQDirect(platformId, errs)
    if (qq && hasTimeAxis(qq)) return { lyric: qq, source: 'QQ 音乐' }
  }
  if (platform === 'netease' && platformId) {
    const ne = await fetchNeteaseById(platformId, errs)
    if (ne && hasTimeAxis(ne)) return { lyric: ne, source: '网易云' }
  }

  // 2) QQ 音乐搜索：在线歌词主力
  const qq = await fetchByQQSearch(clean, a, wantTitle, wantArtist, rawTitle, errs)
  if (qq) return { lyric: qq, source: 'QQ 音乐' }

  // 3) 下歌吧：QQ 搜不到的冷门曲、老歌，它曲库更全
  const lmy = await fetchByLmy(clean, a, wantTitle, wantArtist, rawTitle, errs)
  if (lmy) return { lyric: lmy.lyric, source: '下歌吧', plain: lmy.plain || undefined }

  // 4) 酷狗
  const kg = await fetchKugou(clean, a, wantTitle, wantArtist, rawTitle, errs)
  if (kg) return { lyric: kg, source: '酷狗' }

  // 5) 网易云搜索
  const ne = await fetchNeteaseSearch(clean, a, wantTitle, wantArtist, rawTitle, errs)
  if (ne) return { lyric: ne, source: '网易云' }

  return { lyric: null, error: errs.join(' | ') || 'no source matched' }
}

// ------------------------------------------------------------------ QQ 音乐

async function fetchQQDirect(songmid: string, errs: string[]): Promise<string | null> {
  try {
    const t = await getText(
      `https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric.fcg?songmid=${enc(songmid)}&format=json&nobase64=1`,
      QQ_HEADERS
    ).catch((e) => {
      errs.push('qqd ' + short(e))
      return ''
    })
    if (!t) return null
    const j = parseMaybeJsonp(t)
    const lyric: string | undefined = j?.lyric
    if (!lyric) {
      errs.push('qqd no lyric code=' + (j?.code ?? '?'))
      return null
    }
    return lyric.replace(/\\n/g, '\n').trim()
  } catch (e) {
    errs.push('qqd ' + short(e))
    return null
  }
}

/**
 * 按歌名 + 歌手去 QQ 音乐搜，再逐个候选取歌词。
 * 关键词按命中率从高到低试：带版本标签 → 「歌名 歌手」→「歌手 歌名」→ 原始歌名。
 */
async function fetchByQQSearch(
  clean: string,
  a: string,
  wantTitle: string,
  wantArtist: string,
  rawTitle: string,
  errs: string[]
): Promise<string | null> {
  if (!clean) return null
  const cache = new Map<string, QqSong[]>()
  for (const kw of keywordVariants(clean, a, rawTitle).slice(0, 5)) {
    let songs = cache.get(kw)
    if (!songs) {
      songs = await qqSearch(kw, errs)
      cache.set(kw, songs)
    }
    if (!songs.length) continue
    for (const s of rankSongs(songs, wantTitle, wantArtist, rawTitle).slice(0, 4)) {
      const lrc = await qqLyric(s.mid, errs)
      if (lrc && hasTimeAxis(lrc)) return lrc
    }
  }
  return null
}

async function qqSearch(kw: string, errs: string[]): Promise<QqSong[]> {
  if (!kw) return []
  try {
    const body = await getText(
      `${QQ_SEARCH}?format=json&p=1&n=12&w=${enc(kw)}&t=0&cr=1`,
      QQ_HEADERS
    ).catch((e) => {
      errs.push('qqs ' + short(e))
      return ''
    })
    if (!body) return []
    const j = parseMaybeJsonp(body)
    const list: any[] = j?.data?.song?.list ?? []
    const out: QqSong[] = []
    for (const o of list) {
      const mid = String(o?.songmid ?? '')
      const name = String(o?.songname ?? '').trim()
      if (!mid || !name) continue
      const artists: string[] = []
      const arr = o?.singer
      if (Array.isArray(arr)) {
        for (const s of arr) {
          const n = String(s?.name ?? '').trim()
          if (n) artists.push(n)
        }
      }
      out.push({ mid, name, artists })
    }
    if (!out.length) errs.push('qqs:no list')
    return out
  } catch (e) {
    errs.push('qqs ' + short(e))
    return []
  }
}

async function qqLyric(mid: string, errs: string[]): Promise<string | null> {
  try {
    const body = await getText(
      `${QQ_LYRIC}?songmid=${enc(mid)}&format=json&nobase64=1`,
      QQ_HEADERS
    ).catch((e) => {
      errs.push('qql ' + short(e))
      return ''
    })
    if (!body) return null
    const j = parseMaybeJsonp(body)
    const lyric: string | undefined = j?.lyric
    if (!lyric) {
      errs.push('qql no lyric')
      return null
    }
    return lyric.replace(/\\n/g, '\n').trim()
  } catch (e) {
    errs.push('qql ' + short(e))
    return null
  }
}

// ------------------------------------------------------------------ 下歌吧

/**
 * 下歌吧兜底：详情接口直接带一份歌词，不用另外找歌词接口；
 * 而且它是网盘资源站，曲库比 QQ 全，冷门歌经常只有它有。
 * 代价是限流（30 次/60 秒），所以关键词只试两种。
 *
 * 它给的多数是**没有时间轴的纯文本**，比"什么都没有"强：
 * 返回 plain 标记，前端按歌曲时长把歌词均分成时间轴，照样能跟着歌滚。
 */
async function fetchByLmy(
  clean: string,
  a: string,
  wantTitle: string,
  wantArtist: string,
  rawTitle: string,
  errs: string[]
): Promise<{ lyric: string; plain: boolean } | null> {
  if (!clean) return null
  const kws: string[] = []
  if (a) kws.push(`${clean} ${a}`)
  kws.push(clean)
  let plain = ''
  for (const kw of kws) {
    const hits = await lmySearch(kw, errs)
    if (!hits.length) continue
    const ranked = hits
      .map((h) => ({ h, sc: score(h.title, splitArtists(h.artist), wantTitle, wantArtist, rawTitle) }))
      .filter((x) => x.sc >= MATCH_THRESHOLD)
      .sort((x, y) => y.sc - x.sc)
    for (const { h } of ranked.slice(0, 3)) {
      const lrc = await lmyLyrics(h.id, errs)
      if (!lrc) continue
      const text = lrc.trim()
      if (hasTimeAxis(text)) return { lyric: text, plain: false }
      if (!plain) plain = text
    }
    if (plain) break
  }
  return plain ? { lyric: plain, plain: true } : null
}

async function lmySearch(kw: string, errs: string[]): Promise<LmyHit[]> {
  if (!kw) return []
  try {
    const d = await getJson<any>(`${LMY}/api/music/search?q=${enc(kw)}`, LMY_HEADERS).catch((e) => {
      errs.push('lmys ' + short(e))
      return null
    })
    const arr: any[] = Array.isArray(d?.data) ? d.data : []
    return arr
      .map((o: any) => ({
        id: String(o?.id ?? ''),
        title: String(o?.title ?? '').trim(),
        artist: String(o?.artist ?? '').trim(),
      }))
      .filter((h) => h.id && h.title)
  } catch (e) {
    errs.push('lmys ' + short(e))
    return []
  }
}

async function lmyLyrics(id: string, errs: string[]): Promise<string | null> {
  try {
    const d = await getJson<any>(`${LMY}/api/music/${enc(id)}`, LMY_HEADERS).catch((e) => {
      errs.push('lmyd ' + short(e))
      return null
    })
    const lrc = typeof d?.lyrics === 'string' ? d.lyrics : ''
    if (!lrc.trim()) {
      errs.push('lmyd:empty')
      return null
    }
    return lrc
  } catch (e) {
    errs.push('lmyd ' + short(e))
    return null
  }
}

// ------------------------------------------------------------------ 网易云

async function fetchNeteaseById(id: string, errs: string[]): Promise<string | null> {
  try {
    const t = await getText(
      `${NETEASE}/api/song/lyric?id=${id}&lv=1&kv=1&tv=-1`,
      NE_HEADERS
    ).catch((e) => {
      errs.push('ned ' + short(e))
      return ''
    })
    if (!t) return null
    const j = JSON.parse(t)
    const raw: string | undefined = j?.lrc?.lyric ?? j?.lyric
    if (!raw) {
      errs.push('ned no lrc code=' + (j?.code ?? '?'))
      return null
    }
    return raw.trim()
  } catch (e) {
    errs.push('ned ' + short(e))
    return null
  }
}

async function fetchNeteaseSearch(
  clean: string,
  a: string,
  wantTitle: string,
  wantArtist: string,
  rawTitle: string,
  errs: string[]
): Promise<string | null> {
  const kw = [clean, a].filter(Boolean).join(' ')
  if (!kw) return null
  try {
    const d = await getJson<any>(
      `${NETEASE}/api/search/get?s=${enc(kw)}&type=1&limit=10&offset=0`,
      NE_HEADERS
    )
    const songs: any[] = d?.result?.songs ?? []
    if (!songs.length) {
      errs.push('nes:no songs')
      return null
    }
    const ranked = songs
      .map((s: any) => ({
        s,
        sc: score(
          String(s?.name ?? ''),
          splitArtists(neArtist(s)),
          wantTitle,
          wantArtist,
          rawTitle
        ),
      }))
      .filter((x: any) => x.sc >= MATCH_THRESHOLD)
      .sort((x: any, y: any) => y.sc - x.sc)
    for (const { s } of ranked.slice(0, 3)) {
      const id = String(s?.id ?? '')
      if (!id) continue
      const t = await getText(
        `${NETEASE}/api/song/lyric?id=${id}&lv=1&kv=1&tv=-1`,
        NE_HEADERS
      ).catch((e) => {
        errs.push('nes ' + short(e))
        return ''
      })
      if (!t) continue
      const j = JSON.parse(t)
      const raw: string | undefined = j?.lrc?.lyric ?? j?.lyric
      if (raw && hasTimeAxis(raw)) return raw.trim()
    }
    errs.push('nes:no lrc')
    return null
  } catch (e) {
    errs.push('nes ' + short(e))
    return null
  }
}

function neArtist(s: any): string {
  if (Array.isArray(s?.ar)) return s.ar.map((x: any) => String(x?.name ?? '')).join(' / ')
  if (Array.isArray(s?.artists)) return s.artists.map((x: any) => String(x?.name ?? '')).join(' / ')
  return String(s?.artist ?? '')
}

// ------------------------------------------------------------------ 酷狗

async function fetchKugou(
  clean: string,
  a: string,
  wantTitle: string,
  wantArtist: string,
  rawTitle: string,
  errs: string[]
): Promise<string | null> {
  const kw = [clean, a].filter(Boolean).join(' ')
  if (!kw) return null
  try {
    const t = await getText(
      `${KUGOU_SEARCH}?callback=kg&keyword=${enc(kw)}&page=1&pagesize=10`,
      KUGOU_HEADERS
    ).catch((e) => {
      errs.push('kg:search ' + short(e))
      return ''
    })
    if (!t) return null
    const j = parseMaybeJsonp(t)
    const list: any[] = j?.data?.lists ?? []
    if (!list.length) {
      errs.push('kg:no list')
      return null
    }
    const ranked = list
      .map((s: any) => ({
        s,
        sc: score(
          String(s?.SongName || s?.FileName || ''),
          splitArtists(String(s?.SingerName || '')),
          wantTitle,
          wantArtist,
          rawTitle
        ),
      }))
      .filter((x: any) => x.sc >= MATCH_THRESHOLD)
      .sort((x: any, y: any) => y.sc - x.sc)
    if (!ranked.length) {
      errs.push('kg:nomatch')
      return null
    }
    for (const { s } of ranked.slice(0, 2)) {
      const hash = s?.FileHash || s?.MHash || s?.SQFileHash
      const albumId = s?.AlbumId || s?.album_id
      if (!hash) continue
      const lyr = await getText(
        `https://krcs.kugou.com/search?ver=1&man=yes&hash=${hash}&album_id=${albumId || ''}`,
        KUGOU_HEADERS
      ).catch((e) => {
        errs.push('kg:lyricsearch ' + short(e))
        return ''
      })
      if (!lyr) continue
      const lj = parseMaybeJsonp(lyr)
      const cands: any[] = lj?.candidates ?? lj?.ugccandidates ?? lj?.ai_candidates ?? []
      if (!cands.length) continue
      const cand =
        cands.find((x: any) => /中文|lrc/i.test(x?.language || '') || /lrc/i.test(x?.name || '')) ||
        cands[0]
      const dl = await getText(
        `https://lyrics.kugou.com/download?ver=1&id=${cand?.id}&accesskey=${cand?.accesskey}&fmt=lrc&charset=utf8`,
        KUGOU_HEADERS
      ).catch((e) => {
        errs.push('kg:download ' + short(e))
        return ''
      })
      if (!dl) continue
      const dj = parseMaybeJsonp(dl)
      const content: string | undefined = dj?.content
      if (!content) continue
      const lrc = decodeKugouLrc(content)
      if (lrc && hasTimeAxis(lrc)) return lrc.trim()
    }
    return null
  } catch (e) {
    errs.push('kg ' + short(e))
    return null
  }
}

/** 酷狗的 content 是 base64，个别情况下是明文。 */
function decodeKugouLrc(content: string): string {
  try {
    const bin = atob(content)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return new TextDecoder('utf-8').decode(bytes)
  } catch {
    return content
  }
}

// ------------------------------------------------------------------ 匹配口径

/** 搜索关键词按命中率从高到低尝试。 */
function keywordVariants(clean: string, a: string, rawTitle: string): string[] {
  const raw = rawTitle.trim()
  const out: string[] = []
  const push = (s: string) => {
    const v = s.replace(SPACES, ' ').trim()
    if (v && !out.includes(v)) out.push(v)
  }
  const tags = versionTags(raw)
  if (a) {
    if (tags.length) push(`${clean} ${tags[0]} ${a}`)
    push(`${clean} ${a}`)
    push(`${a} ${clean}`)
    if (clean !== raw) push(`${raw} ${a}`)
  }
  push(clean)
  if (clean !== raw) push(raw)
  return out
}

function rankSongs(
  songs: QqSong[],
  wantTitle: string,
  wantArtist: string,
  rawTitle: string
): QqSong[] {
  return songs
    .map((s) => ({ s, sc: score(s.name, s.artists, wantTitle, wantArtist, rawTitle) }))
    .filter((x) => x.sc >= MATCH_THRESHOLD)
    .sort((x, y) => y.sc - x.sc)
    .map((x) => x.s)
}

/**
 * 给候选打分。
 * 歌名：完全相同 10 分，互相包含 6 分，长度相近且有公共片段 4 分
 * 歌手：完全相同 8 分，互相包含 5 分
 * 模糊命中必须歌手完全一致，避免「歌名沾边 + 歌手沾边」凑够分数张冠李戴。
 */
function score(
  name: string,
  artists: string[],
  wantTitle: string,
  wantArtist: string,
  rawWantTitle = ''
): number {
  if (!wantTitle) return 0
  const n = normalize(name)
  const minLen = Math.min(n.length, wantTitle.length)
  let titleScore = 0
  if (n === wantTitle) titleScore = 10
  else if ((n.includes(wantTitle) || wantTitle.includes(n)) && minLen >= 2) titleScore = 6
  else if (
    minLen >= 3 &&
    commonPart(n, wantTitle) >= 2 &&
    Math.max(n.length, wantTitle.length) - minLen <= 2
  )
    titleScore = 4
  else return 0

  // 原曲名没写版本，却搜到伴奏 / 翻唱 / Remix，宁可不要
  if (BAD_VERSION.test(name) && !BAD_VERSION.test(rawWantTitle)) return 0

  if (!wantArtist) {
    // 没有歌手信息时，歌名必须足够接近才敢用
    if (titleScore === 10) return 10
    if (titleScore === 6 && minLen >= 3) return 10
    return 0
  }
  const a = artistScore(artists, wantArtist)
  if (titleScore === 4 && a < 8) return 0
  let total = titleScore + a
  // 同版本优先：原曲是 Live 版就别拿录音室版的时间轴
  const wantTags = versionTags(rawWantTitle)
  const candTags = versionTags(name)
  if (
    wantTags.length &&
    candTags.length &&
    wantTags.some((t) => candTags.some((c) => c.includes(t) || t.includes(c)))
  ) {
    total += 3
  }
  return total
}

function artistScore(artists: string[], wantArtist: string): number {
  let best = 0
  for (const raw of artists) {
    const a = normalize(raw)
    const sc =
      a === wantArtist
        ? 8
        : (a.includes(wantArtist) || wantArtist.includes(a)) &&
          Math.min(a.length, wantArtist.length) >= 2
          ? 5
          : 0
    if (sc > best) best = sc
  }
  return best
}

/** 歌手字段可能是「A & B」「A/B」「A、B」，拆开逐个比对。 */
function splitArtists(raw: string): string[] {
  return raw
    .split(/&|\/|、|,|，|\|/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/** 去掉括号版本信息、Live/伴奏之类尾巴、以及开头的曲目序号。 */
function cleanTitle(s: string): string {
  let out = s.trim()
  for (let i = 0; i < 3; i++) {
    const next = out.replace(BRACKETS, ' ')
    if (next === out) break
    out = next
  }
  out = out.replace(VERSION_TAIL, ' ')
  out = out.replace(LEADING_NO, '')
  return out.replace(SPACES, ' ').trim().replace(/^[-_.]+|[-_.]+$/g, '')
}

/** 歌手字段也可能带括号，但别像歌名那样砍掉 live/版 之类的尾巴。 */
function cleanArtist(s: string): string {
  return s.trim().replace(BRACKETS, ' ').replace(SPACES, ' ').trim()
}

/** 版本标签，用于优先找同版本歌词（Live 现场版别拿录音室版的时间轴）。 */
function versionTags(s: string): string[] {
  const out: string[] = []
  VERSION_TAG.lastIndex = 0
  let m: RegExpExecArray | null = null
  while ((m = VERSION_TAG.exec(s)) !== null) {
    const v = m[0].toLowerCase()
    if (!out.includes(v)) out.push(v)
    if (out.length >= 2) break
  }
  VERSION_TAG.lastIndex = 0
  return out
}

/** 去掉空格与常见标点，便于比较歌名歌手。 */
function normalize(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
}

/** 最长公共子串长度（歌名很短，暴力比对即可）。 */
function commonPart(a: string, b: string): number {
  let best = 0
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      let k = 0
      while (i + k < a.length && j + k < b.length && a[i + k] === b[j + k]) k++
      if (k > best) best = k
    }
  }
  return best
}

/** 没有时间轴的纯文本歌词没法滚动显示，直接丢掉。 */
function hasTimeAxis(lrc: string): boolean {
  return /\[\d{1,2}:\d{1,2}(?:[.:]\d{1,3})?\]/.test(lrc)
}

function short(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e)
  return m.slice(0, 80)
}

function parseMaybeJsonp(t: string): any {
  try {
    return JSON.parse(t)
  } catch {
    const m = /\((\{[\s\S]*\})\)$/.exec(t) ?? /(\{[\s\S]*\})/.exec(t)
    if (m) {
      try {
        return JSON.parse(m[1])
      } catch {
        return null
      }
    }
    return null
  }
}
