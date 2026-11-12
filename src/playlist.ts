/**
 * 歌单导入：网易云 / QQ 音乐，协议照搬 Android 客户端 PlaylistRepository。
 * 只认「链接 / 纯数字 id」，短链会跟一次重定向。
 */
import type { ImportedPlaylist, Platform, Track } from './types'
import { UA_NETEASE, UA_QQ, enc, getJson, http, https } from './util'

const NETEASE = 'https://music.163.com'
const QQ_HOST = 'https://u.y.qq.com'
const QQ_REFERER = 'https://i2.y.qq.com/n3/other/pages/details/playlist.html'
const NE_HEADERS = { 'User-Agent': UA_NETEASE, Referer: `${NETEASE}/` }
const QQ_HEADERS = { 'User-Agent': UA_QQ, Referer: QQ_REFERER }
/** QQ 专辑封面：拿 albummid 直接拼，跟安卓客户端一致 */
const QQ_ARTWORK = 'https://y.gtimg.cn/music/photo_new/T002R500x500M000%s.jpg'

/** 把接口给的封面地址规整成 https 直链；空值返回空串 */
function normalizeCover(u: unknown): string {
  const s = String(u ?? '').trim()
  if (!s) return ''
  return https(s.startsWith('http') ? s : `https://${s}`)
}
function qqCover(mid: unknown): string {
  const m = String(mid ?? '').trim()
  return m ? QQ_ARTWORK.replace('%s', m) : ''
}

export interface Ref {
  platform: Platform
  id: string
}

export function parseRef(input: string, platform?: Platform): Ref | null {
  let s = input.trim()
  if (!s) return null

  // QQ 转发到微信的分享文本里嵌着真正的歌单链接
  const nested = /itemurl=([^&\s]+)/i.exec(s)?.[1]
  if (nested) {
    let d = nested
    for (let i = 0; i < 3; i++) {
      try {
        const next = decodeURIComponent(d)
        if (next === d) break
        d = next
      } catch {
        break
      }
    }
    const inner = parseRef(d, platform)
    if (inner) return inner
    s = d
  }

  const lower = s.toLowerCase()
  if (lower.includes('qq.com')) {
    const m = /(?:playlist\/|taoge\.html\?id=|disstid=|[?&]id=)(\d+)/.exec(s)
    if (m) return { platform: 'qq', id: m[1] }
  }
  if (lower.includes('163.com')) {
    const m = /(?:playlist\?id=|playlist\/)(\d+)/.exec(s)
    if (m) return { platform: 'netease', id: m[1] }
  }
  // 纯数字两家 id 有歧义，默认网易云，界面上可手选 QQ
  if (/^\d+$/.test(s)) return { platform: platform ?? 'netease', id: s }
  return null
}

export async function resolveRef(input: string, platform?: Platform): Promise<Ref | null> {
  const direct = parseRef(input, platform)
  if (direct) return direct
  if (!/^https?:\/\//i.test(input.trim())) return null
  let cur = input.trim()
  for (let i = 0; i < 6; i++) {
    const r = await http(cur, {
      headers: { 'User-Agent': UA_NETEASE },
      redirect: 'manual',
      timeoutMs: 6000,
    }).catch(() => null)
    if (!r) return null
    const loc = r.headers.get('location')
    if (!loc) return parseRef(cur, platform)
    try {
      cur = https(new URL(loc, cur).toString())
    } catch {
      return null
    }
    const hit = parseRef(cur, platform)
    if (hit) return hit
  }
  return null
}

export async function fetchPlaylist(ref: Ref): Promise<ImportedPlaylist> {
  return ref.platform === 'qq' ? fetchQQ(ref.id) : fetchNetease(ref.id)
}

async function fetchNetease(id: string): Promise<ImportedPlaylist> {
  const d = await getJson<any>(
    `${NETEASE}/api/v6/playlist/detail?id=${id}&n=1000&s=0`,
    NE_HEADERS
  )
  const pl = d?.playlist
  if (!pl) throw new Error('歌单不存在，或者是私享 / 需要登录的歌单')
  const ids: number[] = (pl.trackIds ?? [])
    .map((x: any) => Number(x.id))
    .filter((x: number) => x > 0)
  if (!ids.length) throw new Error('这张歌单里没有歌')

  const tracks: Track[] = []
  for (let i = 0; i < ids.length; i += 50) {
    const detail = await getJson<any>(
      `${NETEASE}/api/song/detail/?ids=${enc(JSON.stringify(ids.slice(i, i + 50)))}`,
      NE_HEADERS
    ).catch(() => null)
    for (const s of detail?.songs ?? []) {
      const sid = Number(s.id)
      if (!sid || !s.name) continue
      tracks.push({
        key: `netease:${sid}`,
        title: String(s.name).trim(),
        artist: (s.artists ?? []).map((a: any) => a.name).filter(Boolean).join(' / '),
        album: s.album?.name ?? '',
        durationSec: Math.round(Number(s.duration ?? 0) / 1000),
        platform: 'netease',
        platformId: String(sid),
        coverUrl: normalizeCover(s.album?.picUrl),
      })
    }
  }
  return { name: pl.name || '未命名歌单', platform: 'netease', id, tracks }
}

async function fetchQQ(disstid: string): Promise<ImportedPlaylist> {
  const numeric = Number(disstid)
  if (!Number.isFinite(numeric)) throw new Error('歌单 id 不合法')

  const tracks: Track[] = []
  const seen = new Set<string>()
  let name = ''
  let begin = 0

  for (let page = 0; page < 60; page++) {
    const body = {
      comm: { cv: '10020000' },
      req_0: {
        module: 'music.srfDissInfo.aiDissInfo',
        method: 'uniform_get_Dissinfo',
        param: {
          disstid: numeric,
          enc_host_uin: '',
          tag: 1,
          userinfo: 1,
          song_begin: begin,
          song_num: 300,
          orderlist: 1,
        },
      },
    }
    const res = await getJson<any>(
      `${QQ_HOST}/cgi-bin/musicu.fcg?data=${enc(JSON.stringify(body))}`,
      QQ_HEADERS
    )
    const req = res?.req_0
    if (!req) throw new Error('QQ 音乐返回格式变了，这个歌单先拉不了')
    if (req.code !== 0) throw new Error(qqError(req.code))
    const data = req.data
    if (!data) break
    if (!name) name = data.dirinfo?.title ?? ''
    const list: any[] = data.songlist ?? []
    if (!list.length) break

    const before = tracks.length
    for (let i = 0; i < list.length; i++) {
      const s = list[i]
      const mid = s.songmid || s.mid || ''
      const title = String(s.title || s.title_hilight || '').trim()
      if (!title) continue
      const key = mid ? `qq:${mid}` : `qq:${begin}:${i}`
      if (seen.has(key)) continue
      seen.add(key)
      tracks.push({
        key,
        title,
        artist: (s.singer ?? []).map((x: any) => x.name).filter(Boolean).join(' / '),
        album: s.album?.name ?? '',
        durationSec: Number(s.interval ?? 0),
        platform: 'qq',
        platformId: mid,
        coverUrl: qqCover(s.album?.mid || s.album?.pmid || s.albummid),
      })
    }
    begin += list.length
    if (tracks.length === before) break
  }

  if (!tracks.length) throw new Error('这张歌单里没拉到歌，可能需要登录')
  return { name: name || '未命名歌单', platform: 'qq', id: disstid, tracks }
}

/** 搜索点歌：复用网易云搜索，返回可直接播放的 Track 列表。 */
export async function searchTracks(keyword: string): Promise<Track[]> {
  const k = keyword.trim()
  if (!k) return []
  const d = await getJson<any>(
    `${NETEASE}/api/search/get?s=${enc(k)}&type=1&limit=30&offset=0`,
    NE_HEADERS
  ).catch(() => null)
  const songs: any[] = d?.result?.songs ?? []
  if (!songs.length) return []

  // 搜索结果只给 album.picId，没有可直接用的封面地址；
  // 一次批量 song/detail 把整批封面补齐，避免每首歌各自再查一次。
  const ids = songs.map((s) => Number(s.id)).filter((x) => x > 0)
  const picById = new Map<number, string>()
  if (ids.length) {
    const detail = await getJson<any>(
      `${NETEASE}/api/song/detail/?ids=${enc(JSON.stringify(ids))}`,
      NE_HEADERS
    ).catch(() => null)
    for (const x of detail?.songs ?? []) {
      const u = normalizeCover(x.album?.picUrl)
      if (u) picById.set(Number(x.id), u)
    }
  }

  return songs
    .map((s) => ({
      key: `netease:${s.id}`,
      title: String(s.name ?? '').trim(),
      artist: (s.artists ?? []).map((a: any) => a.name).filter(Boolean).join(' / '),
      album: s.album?.name ?? '',
      durationSec: Math.round(Number(s.duration ?? 0) / 1000),
      platform: 'netease' as const,
      platformId: String(s.id),
      coverUrl: picById.get(Number(s.id)) ?? '',
    }))
    .filter((t) => t.title)
}

function qqError(code: number): string {
  switch (code) {
    case 80120: return '这个歌单不存在或者已经下架了'
    case 10006: return '歌单 id 不合法'
    case 500003: return 'QQ 音乐拒绝了这次请求，稍后再试试'
    default: return `QQ 音乐接口报错（${code}），可能需要登录或已失效`
  }
}
