/**
 * 夸克网盘直链（下歌吧给的是分享链接，需要三段式换直链）。
 * 协议照搬 Android 客户端 QuarkClient。
 *
 * 最关键的一点：file/download 的响应会刷新 __puus，CDN 只认刷新后的值，
 * 拿登录时那份旧 Cookie 去 GET 直链一律 412。所以每条直链各带各的 Cookie。
 */
import {
  QUARK_REFERER,
  UA_PC,
  enc,
  getJson,
  https,
  http,
  mergePuus,
  setCookiesOf,
} from './util'

const HOST = 'https://drive-pc.quark.cn'
const AUDIO_EXT = /\.(mp3|flac|wav|m4a|aac|ogg|ape)$/i

export interface QuarkDirect {
  url: string
  cookie: string
  fileName: string
  size: number
}

function headers(cookie: string): Record<string, string> {
  return {
    'User-Agent': UA_PC,
    Referer: QUARK_REFERER,
    'Content-Type': 'application/json',
    Cookie: cookie,
  }
}

export function pwdIdOf(share: string): string | null {
  const m = /pan\.quark\.cn\/s\/([A-Za-z0-9]+)/.exec(share)
  if (m) return m[1]
  const s = share.trim()
  return /^[A-Za-z0-9]{8,20}$/.test(s) ? s : null
}

function quality(name: string): number {
  if (/\.flac$/i.test(name)) return 5
  if (/\.wav$/i.test(name)) return 4
  if (/\.mp3$/i.test(name)) return 3
  return 1
}

export async function quarkDirect(shareUrl: string, cookie: string): Promise<QuarkDirect | null> {
  const pwdId = pwdIdOf(shareUrl)
  if (!pwdId || !cookie.trim()) return null

  // 1) 拿 stoken
  const tokenRes = await http(`${HOST}/1/clouddrive/share/sharepage/token?pr=ucpro&fr=pc`, {
    method: 'POST',
    headers: headers(cookie),
    body: JSON.stringify({ pwd_id: pwdId, passcode: '' }),
  })
  const tokenJson = (await tokenRes.json().catch(() => null)) as any
  const stoken = tokenJson?.data?.stoken
  if (!stoken) return null

  // 2) 列分享里的文件，挑音质最高的音频
  const detailUrl =
    `${HOST}/1/clouddrive/share/sharepage/detail?pr=ucpro&fr=pc` +
    `&pwd_id=${enc(pwdId)}&stoken=${enc(stoken)}` +
    `&_fetch_share=1&_fetch_banner=1&_fetch_total=1&_page=1&_size=100`
  const dJson = await getJson<any>(detailUrl, headers(cookie)).catch(() => null)
  const files: any[] = (dJson?.data?.list ?? []).filter((f: any) =>
    AUDIO_EXT.test(String(f.file_name ?? ''))
  )
  if (!files.length) return null
  files.sort(
    (a, b) =>
      quality(String(b.file_name)) - quality(String(a.file_name)) ||
      Number(b.size ?? 0) - Number(a.size ?? 0)
  )
  const f = files[0]

  // 3) 签直链，同时把刷新的 __puus 合进 Cookie
  const dlRes = await http(`${HOST}/1/clouddrive/file/download?pr=ucpro&fr=pc`, {
    method: 'POST',
    headers: headers(cookie),
    body: JSON.stringify({
      fid_list: [f.fid],
      fids: [f.fid],
      pwd_id: pwdId,
      stoken,
    }),
  })
  const linkCookie = mergePuus(cookie, setCookiesOf(dlRes))
  const dlJson = (await dlRes.json().catch(() => null)) as any
  const url = dlJson?.data?.[0]?.download_url
  if (!url) return null

  return {
    url: https(String(url)),
    cookie: linkCookie,
    fileName: String(f.file_name ?? 'audio'),
    size: Number(f.size ?? dlJson?.data?.[0]?.size ?? 0),
  }
}
