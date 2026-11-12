/**
 * 搜歌：网易云 + 夸克网盘（下歌吧）两源并行，结果带音源标签。
 *
 * 口径对齐安卓 MusicSearchRepository.searchMulti：
 *   - 两源各自搜，同名同歌手的合并成一条（两个源都能播）
 *   - 夸克源只收 quality 里带「夸克」的条目（百度云那份网页版下不了）
 *   - 搜索阶段不解析直链（解析要 4 步网络请求，几十条全探一遍会卡死），
 *     只标「网盘里有这份资源」，点播放时再解析
 */
import type { Track } from './types'
import { searchTracks } from './playlist'
import { UA_PC, enc, getJson, https } from './util'
import { artistHit, norm, variantTag } from './match'

export type SourceId = 'netease' | 'quark'

export const SOURCE_LABEL: Record<SourceId, string> = {
  netease: '网易云',
  quark: '夸克网盘',
}

export interface SearchHit extends Track {
  /** 这首歌能在哪些源上播 */
  sources: SourceId[]
  /** 展示文案：'网易云' / '夸克网盘' / '网易云 · 夸克网盘' */
  sourceLabel: string
  /** 下歌吧 id：播放时直接用它取直链，避免同名歌找错文件 */
  quarkId?: string
}

export interface SearchResult {
  hits: SearchHit[]
  /** 每个源一行结论 */
  notes: string[]
  counts: { all: number; netease: number; quark: number }
}

const LMY = 'https://so.liumingye.cn'
const LMY_HEADERS = {
  'User-Agent': UA_PC,
  Accept: 'application/json, text/plain, */*',
  Referer: `${LMY}/`,
}

export async function searchMulti(keyword: string, cookie = ''): Promise<SearchResult> {
  const kw = keyword.trim()
  if (!kw) return { hits: [], notes: [], counts: { all: 0, netease: 0, quark: 0 } }

  // 两源并行，谁慢不拖累谁
  const [ne, qk] = await Promise.all([searchTracks(kw), searchQuark(kw)])

  const hits: SearchHit[] = ne.map((t) => ({
    ...t,
    sources: ['netease' as SourceId],
    sourceLabel: SOURCE_LABEL.netease,
  }))

  // 同名同歌手的合并成一条（两个源都能播）
  for (const q of qk) {
    const hit = hits.find((h) => sameSong(h, q))
    if (hit) {
      if (!hit.sources.includes('quark')) hit.sources.push('quark')
      hit.sourceLabel = hit.sources.map((s) => SOURCE_LABEL[s]).join(' · ')
      if (!hit.quarkId) hit.quarkId = q.quarkId
    } else {
      hits.push({ ...q, sources: ['quark'], sourceLabel: SOURCE_LABEL.quark })
    }
  }

  // 按匹配度排序（安卓同口径：歌名命中 +10，歌手命中 +8，歌名带后缀/衍生版本降权）
  const want = kw.split(/[\s,，、]+/).filter(Boolean)
  hits.sort((a, b) => scoreHit(b, want) - scoreHit(a, want))

  const counts = {
    all: hits.length,
    netease: hits.filter((h) => h.sources.includes('netease')).length,
    quark: hits.filter((h) => h.sources.includes('quark')).length,
  }
  const notes = [`网易云 ${counts.netease} 首`, `夸克网盘 ${counts.quark} 首`]
  if (counts.quark && !cookie.trim()) notes.push('夸克网盘要登录才能下完整版')

  return { hits, notes, counts }
}

/** 同名同歌手才认为是同一首歌（歌名要完全一致，「治愈版」「Live」不算同一首） */
function sameSong(
  a: { title: string; artist: string },
  b: { title: string; artist: string }
): boolean {
  const na = norm(a.title)
  const nb = norm(b.title)
  if (!na || !nb || na !== nb) return false
  return artistHit(a.artist, b.artist) || artistHit(b.artist, a.artist)
}

/** 搜索结果的匹配度：歌名命中 +10，歌手命中 +8，歌名带后缀 / 衍生版本降权 */
function scoreHit(h: SearchHit, want: string[]): number {
  const t = norm(h.title)
  const a = norm(h.artist)
  let s = 0
  let hitTitle = false
  for (const w of want) {
    const nw = norm(w)
    if (!nw) continue
    if (t === nw) { s += 10; hitTitle = true }
    else if (t.includes(nw)) { s += 6; hitTitle = true }
    if (a.includes(nw)) s += 8
  }
  // 歌名比关键词长 → 多半带了后缀（治愈版 / Live / 钢琴版），降权
  const longest = Math.max(0, ...want.map((w) => norm(w).length))
  if (hitTitle && t.length > longest) s -= 4
  if (variantTag(h.title, h.artist)) s -= 6
  return s
}

/** 夸克网盘源：走下歌吧搜索，只收带「夸克」分享的条目 */
async function searchQuark(kw: string): Promise<SearchHit[]> {
  const d = await getJson<any>(
    `${LMY}/api/music/search?q=${enc(kw)}`,
    LMY_HEADERS
  ).catch(() => null)
  const list: any[] = Array.isArray(d?.data) ? d.data : []
  const out: SearchHit[] = []
  for (const o of list) {
    const quality: string[] = Array.isArray(o.quality)
      ? o.quality.map((x: unknown) => String(x))
      : []
    if (!quality.some((q) => /夸克/i.test(q))) continue  // 百度云那份网页版下不了
    const id = String(o.id ?? '')
    const title = String(o.title ?? '').trim()
    if (!id || !title) continue
    out.push({
      key: `quark:${id}`,
      title,
      artist: String(o.artist ?? '').trim(),
      album: String(o.album ?? '').trim(),
      durationSec: 0,               // 下歌吧不给时长
      platform: 'netease',          // 封面/歌词按歌名歌手检索，不走平台 id
      coverUrl: o.cover ? https(String(o.cover)) : '',
      sources: ['quark'],
      sourceLabel: SOURCE_LABEL.quark,
      quarkId: id,
    })
  }
  return out
}
