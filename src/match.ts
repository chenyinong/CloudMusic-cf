/**
 * 从 Android 客户端 SearchKeywords / TrackMatcher 搬过来的匹配规则。
 * 目的：歌名清洗、多人歌手取首位、衍生版本降权、试听片段判定，三端保持一致。
 */

const BRACKET = /[（(【\[].*?[)）】\]]/g
const ARTIST_SEP = /\s*\/\s*|\s*&\s*|\s*、\s*|\s*[,，;；]\s*|\s+feat\.?\s*|\s+ft\.?\s*/i
const SPACE = /\s+/g
const MAX_LEN = 24

/** 歌单没给时长时的兜底：45 秒以内基本都是平台试听片段。 */
export const ABSOLUTE_PARTIAL_MAX_SEC = 45

function clean(s: string): string {
  return s.replace(BRACKET, ' ').replace(SPACE, ' ').trim()
}

function firstArtist(artist: string): string {
  return clean(artist.split(ARTIST_SEP)[0] ?? '')
}

/** 纯歌名 → 纯歌名+首位歌手 → 原始歌名，去重并截到 24 字。 */
export function keywords(title: string, artist: string): string[] {
  const main = clean(title)
  const raw = title.replace(SPACE, ' ').trim()
  const singer = firstArtist(artist)
  const out = new Set<string>()
  const add = (s: string) => {
    const k = s.replace(SPACE, ' ').trim()
    if (k) out.add(k.slice(0, MAX_LEN))
  }
  add(main)
  if (singer && main.length + 1 + singer.length <= MAX_LEN) add(`${main} ${singer}`)
  if (raw && raw !== main && raw.length <= MAX_LEN) add(raw)
  return [...out]
}

/** 归一化：小写 + 只保留字母/数字（含中文）。 */
export function norm(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
}

export function stripBrackets(s: string): string {
  return s.replace(BRACKET, ' ').trim()
}

export function sameTitle(a: string, b: string): boolean {
  const na = norm(stripBrackets(a))
  const nb = norm(stripBrackets(b))
  return na.length > 0 && na === nb
}

export function artistHit(target: string, candidate: string): boolean {
  const n = norm(target)
  if (!n) return true
  const c = norm(candidate)
  return c.length > 0 && c.includes(n)
}

export function durationClose(a: number, b: number, tolerance = 5): boolean {
  return a > 0 && b > 0 && Math.abs(a - b) <= tolerance
}

/** 明显比目标短 = 片段（阈值 60%，与客户端一致）。 */
export function tooShort(realSec: number, targetSec: number): boolean {
  return realSec > 0 && targetSec > 0 && realSec < targetSec * 0.6
}

/** 综合判定：真实时长 + 文件字节数都算，任何一个明显偏短就是片段。 */
export function isPartial(
  realSec: number,
  targetSec: number,
  totalBytes: number,
  bytesPartial: boolean
): boolean {
  if (tooShort(realSec, targetSec)) return true
  if (targetSec <= 0 && realSec > 0 && realSec <= ABSOLUTE_PARTIAL_MAX_SEC) return true
  if (totalBytes > 0 && bytesPartial) return true
  return false
}

const VARIANT_TAGS: Array<[RegExp, string]> = [
  [/伴奏/, '伴奏'],
  [/纯音乐|instrumental/i, '纯音乐'],
  [/\blive\b|演唱会|现场/i, '现场版'],
  [/\bdj\b/i, 'DJ版'],
  [/\bremix\b/i, 'Remix'],
  [/\bdemo\b/i, 'Demo'],
  [/翻唱|\bcover\b/i, '翻唱'],
  [/铃声|rington/i, '铃声'],
]

export function variantTag(title: string, artist = ''): string | null {
  const raw = `${title} ${artist}`
  for (const [re, tag] of VARIANT_TAGS) if (re.test(raw)) return tag
  return null
}

export function rank(title: string, artist: string, targetSec: number, c: {
  title: string
  artist: string
  durationSec: number
}): number {
  let s = 0
  if (sameTitle(c.title, title)) s += 10
  if (artistHit(artist, c.artist)) s += 8
  if (durationClose(c.durationSec, targetSec)) s += 5
  if (variantTag(c.title, c.artist)) s -= 8
  return s
}
