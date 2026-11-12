/**
 * 专辑封面：用 iTunes 公开搜索接口拿封面图（无需鉴权，Worker 端请求避开 CORS）。
 * 返回大图地址（把 100x100 换成 600x600）。
 */
import { getJson } from './util'

const ITUNES = 'https://itunes.apple.com/search'

export async function fetchCover(title: string, artist: string): Promise<string | null> {
  const term = [artist, title].filter(Boolean).join(' ').trim()
  if (!term) return null
  const d = await getJson<any>(
    `${ITUNES}?term=${encodeURIComponent(term)}&entity=song&media=music&limit=10`,
    { 'User-Agent': 'Mozilla/5.0' }
  ).catch(() => null)
  const results: any[] = d?.results ?? []
  const pick = results.find((x) => x.artworkUrl100) ?? null
  if (!pick) return null
  return String(pick.artworkUrl100).replace(/100x100bb\.(jpg|png)/, '600x600bb.$1')
}
