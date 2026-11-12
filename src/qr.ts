/**
 * 二维码本地生成：把 qrcode-generator 的模块矩阵拼成一张 SVG。
 *
 * 之前用 api.qrserver.com 代理出图，Worker 出站经常 502；现在是纯计算，
 * 不发起任何外部请求，部署到 Cloudflare 后也不依赖第三方服务可用性。
 */
import qrcode from 'qrcode-generator'

// 库默认只按单字节处理字符串，URL 里若带中文会截断；统一走 UTF-8。
qrcode.stringToBytes = (s: string) => Array.from(new TextEncoder().encode(s))

const CELL = 8
const MARGIN = 4

export function qrSvg(text: string): string {
  const qr = qrcode(0, 'M') // typeNumber = 0：自动挑最小版本
  qr.addData(text, 'Byte')
  qr.make()

  const n = qr.getModuleCount()
  const side = (n + MARGIN * 2) * CELL
  let d = ''
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      if (!qr.isDark(row, col)) continue
      const x = (col + MARGIN) * CELL
      const y = (row + MARGIN) * CELL
      d += `M${x} ${y}h${CELL}v${CELL}h-${CELL}z`
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${side}" height="${side}" ` +
    `viewBox="0 0 ${side} ${side}" shape-rendering="crispEdges">` +
    `<rect width="100%" height="100%" fill="#fff"/>` +
    `<path d="${d}" fill="#000"/></svg>`
  )
}
