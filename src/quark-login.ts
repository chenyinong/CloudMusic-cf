/**
 * 夸克网盘扫码登录（官方 CAS 接口）。
 *
 * 安卓客户端靠 WebView + CookieManager 抓 Cookie，浏览器里做不到（跨域 +
 * HttpOnly），所以改走夸克 PC 网页版自己用的扫码登录：
 *
 *   1. getTokenForQrcodeLogin            → token + request_id + _UP_* 会话 Cookie
 *   2. 二维码内容 su.quark.cn/4_eMHBJ?token=...，用夸克 App 扫
 *   3. getServiceTicketByQrcodeToken    → service_ticket（未扫时 status != 2000000）
 *   4. pan.quark.cn/account/info?st=...  → 跟重定向，逐跳收集 Set-Cookie（含 __pus）
 *
 * Worker 无状态，第一步的 _UP_* Cookie 和 token 用 AES-GCM 封进 loginToken
 * 交给前端带回，Cookie 本身不会明文出现在 URL 或前端存储里。
 */
import { UA_PC, enc, http, mergeCookies, seal, setCookiesOf, unseal } from './util'

const CAS = 'https://uop.quark.cn'
const PAN = 'https://pan.quark.cn'
const CLIENT_ID = '532'
const VERSION = '1.2'
const LOGIN_TTL_MS = 5 * 60 * 1000

// 确认页实际落在 b.quark.cn，手机「确认登录」请求来源也是 b.quark.cn。
// CAS 按来源域关联扫码会话：确认写进 b 域，若我们用 pan.quark.cn 去查就永远 empty。
// 所以创建/轮询/换票的来源域必须统一成 b.quark.cn。
const CAS_HEADERS: Record<string, string> = {
  'User-Agent': UA_PC,
  Referer: 'https://b.quark.cn/',
  Origin: 'https://b.quark.cn',
}

interface LoginState {
  token: string
  requestId: string
  cookies: string
  exp: number
}

export type PollResult = {
  status: 'waiting' | 'expired' | 'ok'
  message?: string
  cookie?: string
  account?: string
  debug?: string
}

export async function startLogin(secret: string): Promise<{
  loginToken: string
  qrText: string
  qrImage: string
}> {
  const requestId = crypto.randomUUID()
  const r = await http(
    `${CAS}/cas/ajax/getTokenForQrcodeLogin?client_id=${CLIENT_ID}&v=${VERSION}&request_id=${enc(requestId)}`,
    { headers: CAS_HEADERS }
  )
  const cookies = mergeCookies('', setCookiesOf(r))
  const j = (await r.json().catch(() => null)) as any
  const token: string = j?.data?.members?.token ?? ''
  if (j?.status !== 2000000 || !token) {
    throw new Error(`夸克没给二维码 token：${j?.message ?? r.status}`)
  }

  const state: LoginState = { token, requestId, cookies, exp: Date.now() + LOGIN_TTL_MS }
  const loginToken = await seal(state, secret)

  // 确认页真实地址由短链 4_eMHBJ 重定向到 b.quark.cn。短链重定向会丢掉 token 参数，
  // 确认页拿不到 token 就无法把「确认」绑定到这个会话，CAS 里就一直 empty。
  // 所以这里直接把 token 拼到落地确认页 URL 上（短链重定向 Location 已含 uc_param_str）。
  let confirmUrl =
    'https://b.quark.cn/apps/DuJrlezmS/routes/EATJRLSvv?uc_param_str=dsdnfrpfbivesscpgimibtbmnijblauputogpintnwktprchmt'
  try {
    const qr = await http(`https://su.quark.cn/4_eMHBJ?token=${enc(token)}`, { redirect: 'manual' })
    const loc = qr.headers.get('location')
    if (loc) confirmUrl = loc.split('#')[0]
  } catch {
    /* 用上面的兜底地址 */
  }
  const sep = confirmUrl.includes('?') ? '&' : '?'
  // 确认页从 URL query 读取 token 与 client_id，并据此调用 loginWithKpsAndQrcodeToken 确认。
  // 短链重定向会丢掉 query，所以必须直接拼到落地确认页 URL 上；且 client_id 必须与轮询
  // getServiceTicketByQrcodeToken 用的 532 一致，否则 CAS 的确认记录对不上轮询查询（50004001）。
  const qrText = `${confirmUrl}${sep}client_id=${CLIENT_ID}&token=${enc(token)}`
  return {
    loginToken,
    qrText,
    qrImage: `/api/qr?data=${encodeURIComponent(qrText)}`,
  }
}

export async function pollLogin(loginToken: string, secret: string): Promise<PollResult> {
  const s = await unseal<LoginState>(loginToken, secret)
  if (!s) {
    return {
      status: 'expired',
      message: '登录会话无效，重新点一次扫码登录',
      debug: 'unseal 失败：loginToken 解密不出来（可能来自旧页面或被截断）',
    }
  }
  if (s.exp < Date.now()) {
    return { status: 'expired', message: '二维码已过期，重新点一次', debug: 'loginToken 已超后端有效期' }
  }

  // 轮询只靠 token + request_id 关联，不能带 getToken 时的 _UP_* Cookie，
  // 否则 CAS 可能把查询定位到别的会话、反而查不到这个 token 的结果（跑通实现即不带 Cookie）
  const rid = s.requestId
  const headers = { ...CAS_HEADERS }
  const pollUrl =
    `${CAS}/cas/ajax/getServiceTicketByQrcodeToken?client_id=${CLIENT_ID}&v=${VERSION}` +
    `&token=${enc(s.token)}&request_id=${enc(rid)}`
  const pr = await http(pollUrl, { headers })
  const pj = (await pr.json().catch(() => null)) as any
  const debug =
    `qr_status=${pj?.status} qr_msg=${pj?.message ?? '(无)'} ` +
    `token=${s.token.slice(0, 8)} rid=${rid.slice(0, 8)} cookie=${s.cookies ? 'Y' : 'N'}`

  // 未扫码：{"status":50004001,"message":"Query result is empty"}
  if (pj?.status !== 2000000) {
    return { status: 'waiting', message: String(pj?.message ?? '等待扫码'), debug }
  }
  const st: string = pj?.data?.members?.service_ticket ?? ''
  if (!st) return { status: 'waiting', message: '已扫码，等夸克下发凭证', debug }

  const { cookie, account } = await exchangeTicket(st, s.cookies)
  const gotPus = cookie.includes('__pus')
  const dbg = `${debug} st=${!!st} pus=${gotPus} acct=${account || '(无)'}`
  if (!gotPus) {
    return { status: 'waiting', message: '已扫码，正在种 Cookie…（若长时间不变请重扫）', debug: dbg }
  }
  return { status: 'ok', cookie, account, debug: dbg }
}

/**
 * service_ticket 换登录态。夸克会 302 好几跳，Cookie 分散在每一跳的
 * Set-Cookie 里，必须手动跟随并合并，直接 follow 会丢掉中间那些。
 */
async function exchangeTicket(
  st: string,
  seed: string
): Promise<{ cookie: string; account: string }> {
  let cookie = seed
  let account = ''
  let url = `${PAN}/account/info?st=${enc(st)}&lw=scan`

  for (let i = 0; i < 6; i++) {
    const r = await http(url, {
      headers: { ...CAS_HEADERS, Cookie: cookie },
      redirect: 'manual',
    })
    cookie = mergeCookies(cookie, setCookiesOf(r))
    if ((r.headers.get('content-type') ?? '').includes('json')) {
      const j = (await r.json().catch(() => null)) as any
      if (j?.data?.nickname) account = String(j.data.nickname)
    }
    const loc = r.headers.get('location')
    if (!loc) break
    let next: string
    try {
      next = new URL(loc, url).toString()
    } catch {
      break
    }
    if (next === url) break
    url = next
  }
  return { cookie, account }
}
