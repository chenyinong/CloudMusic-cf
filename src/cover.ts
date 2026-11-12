/**
 * 专辑封面来源链（对齐安卓 CoverRepository，按「出图速度」命中即止）：
 *   歌单/搜索自带的专辑封面 → QQ 音乐搜索（严格匹配） → iTunes US → 宽松候选 → 无。
 *
 * CF 比安卓多一条零成本路径：歌单和搜索结果的元数据里本来就带封面直链，
 * 绝大多数歌到这步就结束，不用打任何搜索接口。
 * 网盘同目录图 / 音频内嵌封面这两档是安卓网盘专属，网页版没有，故不实现。
 *
 * 匹配口径照搬安卓：歌名完全相同 10 分、包含 6 分；歌手相同 +8、包含 +5。
 * ≥10 为严格命中可直接采用；6~9 分且歌手对得上先记着，全部来源落空才用，
 * 避免「搜到一首同名翻唱」就张冠李戴。
 */
import { enc, getJson, https } from './util'

const QQ_SEARCH = 'https://c.y.qq.com/soso/fcgi-bin/client_search_cp'
const QQ_REFERER = 'https://y.qq.com/'
const QQ_ARTWORK = 'https://y.gtimg.cn/music/photo_new/T002R500x500M000%s.jpg'
const ITUNES = 'https://itunes.apple.com/search'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'

export interface CoverQuery {
  title: string
  artist: string
  album?: string
  coverUrl?: string
}
export interface CoverResult {
  url: string | null
  source: string
  strict: boolean
}

interface Hit { title: string; artist: string; url: string }
interface Scored { hit: Hit; score: number }

const MATCH_STRICT = 10
const MATCH_LOOSE = 6

function normalize(s: string): string {
  return String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
}

/** 去掉括号版本信息、Live/伴奏之类尾巴、以及开头的曲目序号（同安卓 cleanTitle） */
function cleanTitle(s: string): string {
  let out = s
  for (let i = 0; i < 3; i++) {
    const next = out.replace(/[（(【\[][^）)】\]]*[）)】\]]/g, ' ')
    if (next === out) break
    out = next
  }
  out = out.replace(/(live|remix|demo|acoustic|instrumental|karaoke|现场|重制|翻唱|伴奏|纯音乐|版).*$/i, '')
  out = out.replace(/^\s*\d{1,3}[\s.\-_]+/, '')
  return out.replace(/\s+/g, ' ').trim().replace(/^[-_.]+|[-_.]+$/g, '')
}

/** 关键词变体：原始「歌名 歌手」优先，再试洗干净的歌名（同安卓 keywordVariants） */
function keywordVariants(title: string, artist: string): string[] {
  const clean = cleanTitle(title)
  const out = new Set<string>()
  if (artist.trim()) {
    out.add(`${title} ${artist}`)
    if (clean && clean !== title) out.add(`${clean} ${artist}`)
  }
  out.add(title)
  if (clean && clean !== title) out.add(clean)
  return [...out].filter(Boolean)
}

function artistScore(artist: string, want: string): number {
  if (!want) return 0
  if (artist === want) return 8
  if ((artist.includes(want) || want.includes(artist)) && Math.min(artist.length, want.length) >= 2) return 5
  return 0
}
function score(name: string, artist: string, wantTitle: string, wantArtist: string): number {
  if (!wantTitle) return 0
  const minLen = Math.min(name.length, wantTitle.length)
  let titleScore = 0
  if (name === wantTitle) titleScore = 10
  else if ((name.includes(wantTitle) || wantTitle.includes(name)) && minLen >= 2) titleScore = 6
  if (!titleScore) return 0
  if (!wantArtist) return titleScore === 10 ? 10 : 0
  return titleScore + artistScore(artist, wantArtist)
}

/** QQ 搜索结果的 albummid 直接拼 500×500 专辑图；中文曲库大、响应快 */
async function qqHits(keyword: string): Promise<Hit[]> {
  const d = await getJson<any>(
    `${QQ_SEARCH}?format=json&p=1&n=12&w=${enc(keyword)}&t=0&cr=1`,
    { 'User-Agent': UA, Referer: QQ_REFERER }
  ).catch(() => null)
  const list: any[] = d?.data?.song?.list ?? []
  return list
    .map((o) => {
      const mid = String(o?.albummid ?? '').trim()
      const name = String(o?.songname ?? '').trim()
      if (!mid || !name) return null
      const artist = (o?.singer ?? []).map((a: any) => String(a?.name ?? '')).filter(Boolean).join(' ')
      return { title: name, artist, url: QQ_ARTWORK.replace('%s', mid) }
    })
    .filter((x): x is Hit => x !== null)
}

/** iTunes 美国店兜底（country=CN 对中文歌几乎全是空结果，安卓也明确不查 CN） */
async function itunesHits(keyword: string): Promise<Hit[]> {
  const d = await getJson<any>(
    `${ITUNES}?term=${enc(keyword)}&media=music&entity=song&limit=12&country=US`,
    { 'User-Agent': UA }
  ).catch(() => null)
  const list: any[] = d?.results ?? []
  return list
    .map((o) => {
      const name = String(o?.trackName ?? '').trim()
      const art = String(o?.artworkUrl100 ?? '').trim()
      if (!name || !art) return null
      return {
        title: name,
        artist: String(o?.artistName ?? '').trim(),
        url: https(art.replace('100x100bb', '600x600bb')),
      }
    })
    .filter((x): x is Hit => x !== null)
}

function best(hits: Hit[], wantTitle: string, wantArtist: string): { strict?: Scored; loose?: Scored } {
  let strict: Scored | undefined
  let loose: Scored | undefined
  for (const hit of hits) {
    const s = score(normalize(hit.title), normalize(hit.artist), wantTitle, wantArtist)
    const cur = { hit, score: s }
    if (s >= MATCH_STRICT) {
      if (!strict || s > strict.score) strict = cur
    } else if (
      s >= MATCH_LOOSE &&
      wantArtist &&
      artistScore(normalize(hit.artist), wantArtist) > 0 &&
      (!loose || s > loose.score)
    ) {
      loose = cur
    }
  }
  return { strict, loose }
}

export async function fetchCover(q: CoverQuery): Promise<CoverResult> {
  const title = String(q.title || '').trim()
  const artist = String(q.artist || '').trim()

  // 0) 歌单/搜索元数据自带的封面：零成本、最准，直接采用
  const own = String(q.coverUrl || '').trim()
  if (own) return { url: https(own), source: 'metadata', strict: true }
  if (!title) return { url: null, source: 'none', strict: false }

  const wantTitle = normalize(title)
  const wantArtist = normalize(artist)
  const variants = keywordVariants(title, artist)
  let loose: Scored | undefined

  // 1) QQ 音乐：并行试关键词变体，取分数最高的严格命中
  const qqResults = await Promise.all(variants.map((kw) => qqHits(kw)))
  for (const hits of qqResults) {
    const r = best(hits, wantTitle, wantArtist)
    if (r.strict) return { url: r.strict.hit.url, source: 'qq', strict: true }
    if (r.loose && (!loose || r.loose.score > loose.score)) loose = r.loose
  }

  // 2) iTunes US：官方限流较严，只试前两个关键词
  const itunesResults = await Promise.all(variants.slice(0, 2).map((kw) => itunesHits(kw)))
  for (const hits of itunesResults) {
    const r = best(hits, wantTitle, wantArtist)
    if (r.strict) return { url: r.strict.hit.url, source: 'itunes', strict: true }
    if (r.loose && (!loose || r.loose.score > loose.score)) loose = r.loose
  }

  // 3) 全都没严格命中，才用宽松候选（宁可少一张图，也不要贴错专辑）
  if (loose) return { url: loose.hit.url, source: 'loose', strict: false }
  return { url: null, source: 'none', strict: false }
}
