/**
 * 歌词：优先用歌单自带的来源歌曲 id 直取（最精准），失败再用搜索兜底。
 * - QQ 直取：fcg_query_lyric.fcg?songmid=...（已验证可用）
 * - 网易云直取：/api/song/lyric?id=...（部分歌曲受版权限制拿不到）
 * - 兜底搜索：酷狗（匿名、搜索准、可直接拿 LRC），再网易云搜索
 */
import { UA_NETEASE, UA_PC, enc, getJson, getText } from './util'

const NETEASE = 'https://music.163.com'
const NE_HEADERS = { 'User-Agent': UA_NETEASE, Referer: `${NETEASE}/` }
const QQ_HEADERS = { 'User-Agent': UA_PC, Referer: 'https://c.y.qq.com/' }
const KUGOU_HEADERS = { 'User-Agent': UA_PC, Referer: 'https://www.kugou.com/' }

export interface LyricResult {
  lyric: string | null
  source?: string
  error?: string
}

export async function fetchLyric(
  title: string,
  artist: string,
  platform?: string,
  platformId?: string
): Promise<LyricResult> {
  const errs: string[] = []
  // 优先用歌单自带的来源 id 直取，最精准
  if (platform === 'qq' && platformId) {
    const qq = await fetchQQDirect(platformId, errs)
    if (qq) return { lyric: qq, source: 'qq' }
  }
  if (platform === 'netease' && platformId) {
    const ne = await fetchNeteaseById(platformId, errs)
    if (ne) return { lyric: ne, source: 'netease' }
  }
  // 兜底：搜索（酷狗优先，网易云次之）
  const kg = await fetchKugou(title, artist, errs)
  if (kg) return { lyric: kg, source: 'kugou' }
  const ne = await fetchNeteaseSearch(title, artist, errs)
  if (ne) return { lyric: ne, source: 'netease-search' }
  return { lyric: null, error: errs.join(' | ') || 'no source matched' }
}

async function fetchQQDirect(songmid: string, errs: string[]): Promise<string | null> {
  try {
    const t = await getText(
      `https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric.fcg?songmid=${songmid}&format=json&nobase64=1`,
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

async function fetchNeteaseSearch(title: string, artist: string, errs: string[]): Promise<string | null> {
  const kw = [title, artist].filter(Boolean).join(' ')
  if (!kw) return null
  try {
    const d = await getJson<any>(
      `${NETEASE}/api/search/get?s=${enc(kw)}&type=1&limit=8&offset=0`,
      NE_HEADERS
    )
    const songs: any[] = d?.result?.songs ?? []
    if (!songs.length) {
      errs.push('ne:no songs')
      return null
    }
    const id = String(songs[0].id)
    const t = await getText(
      `${NETEASE}/api/song/lyric?id=${id}&lv=1&kv=1&tv=-1`,
      NE_HEADERS
    ).catch((e) => {
      errs.push('ne:lyric ' + short(e))
      return ''
    })
    if (!t) return null
    const j = JSON.parse(t)
    const raw: string | undefined = j?.lrc?.lyric ?? j?.lyric
    if (!raw) {
      errs.push('ne:no lrc code=' + (j?.code ?? '?'))
      return null
    }
    return raw.trim()
  } catch (e) {
    errs.push('ne: ' + short(e))
    return null
  }
}

async function fetchKugou(title: string, artist: string, errs: string[]): Promise<string | null> {
  const kw = [title, artist].filter(Boolean).join(' ')
  if (!kw) return null
  try {
    const t = await getText(
      `https://songsearch.kugou.com/song_search_v2?callback=kg&keyword=${enc(kw)}&page=1&pagesize=10`,
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
    let best = list[0]
    let bestScore = -1
    for (const s of list.slice(0, 8)) {
      const name = String(s.SongName || s.FileName || '')
      const singer = String(s.SingerName || '')
      let score = 0
      if (title && name.includes(title)) score += 2
      if (artist && singer.includes(artist)) score += 2
      if (score > bestScore) {
        bestScore = score
        best = s
      }
    }
    // 没匹配到正确的歌名 / 歌手时，宁可不返回，避免错歌歌词误导
    if (bestScore < 2) {
      errs.push('kg:nomatch')
      return null
    }
    const hash = best?.FileHash || best?.MHash || best?.SQFileHash
    const albumId = best?.AlbumId || best?.album_id
    if (!hash) {
      errs.push('kg:no hash')
      return null
    }
    const lyr = await getText(
      `https://krcs.kugou.com/search?ver=1&man=yes&hash=${hash}&album_id=${albumId || ''}`,
      KUGOU_HEADERS
    ).catch((e) => {
      errs.push('kg:lyricsearch ' + short(e))
      return ''
    })
    if (!lyr) return null
    const lj = parseMaybeJsonp(lyr)
    const cands: any[] =
      lj?.candidates ?? lj?.ugccandidates ?? lj?.ai_candidates ?? []
    if (!cands.length) {
      errs.push('kg:no cand')
      return null
    }
    const cand =
      cands.find((x) => /中文|lrc/i.test(x.language || '') || /lrc/i.test(x.name || '')) ||
      cands[0]
    const dl = await getText(
      `https://lyrics.kugou.com/download?ver=1&id=${cand.id}&accesskey=${cand.accesskey}&fmt=lrc&charset=utf8`,
      KUGOU_HEADERS
    ).catch((e) => {
      errs.push('kg:download ' + short(e))
      return ''
    })
    if (!dl) return null
    const dj = parseMaybeJsonp(dl)
    const content: string | undefined = dj?.content
    if (!content) {
      errs.push('kg:no content')
      return null
    }
    try {
      const bin = atob(content)
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      return new TextDecoder('utf-8').decode(bytes).trim()
    } catch {
      return content.trim()
    }
  } catch (e) {
    errs.push('kg: ' + short(e))
    return null
  }
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
