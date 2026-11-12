/* 封面视觉工具（移动版 / 桌面版共用）
 * 对齐安卓 CoverArt.kt 的 GeneratedCover 与 Components.kt 的 coverColors：
 * 查不到封面时画「渐变天空 + 圆日」，按歌名哈希选调色板和构图。
 * （原来安卓同款还有三层山影，网页版按要求去掉了，封面不再带阴影）
 */
(function (global) {
  // 与安卓 coverColors() 完全一致的 6 组调色板
  var PALETTES = [
    ['#5B8DEF', '#2C5FD8'],
    ['#00B8A9', '#00796B'],
    ['#FF8A65', '#D84315'],
    ['#BA68C8', '#6A1B9A'],
    ['#FFD54F', '#F57F17'],
    ['#4DD0E1', '#00838F'],
  ]

  // Java String.hashCode()，跟安卓 seed.hashCode() 取同一套构图
  function javaHash(s) {
    var h = 0
    s = String(s || '')
    for (var i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0
    return h
  }
  function variantOf(seed) { return Math.abs(javaHash(seed)) }

  function coverColors(seed) { return PALETTES[variantOf(seed) % PALETTES.length] }

  function hexToRgb(hex) {
    var n = parseInt(hex.slice(1), 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  }

  /** 返回可直接当 background-image / img src 用的 SVG data URI */
  function generatedCover(seed) {
    seed = String(seed || '?')
    var p = coverColors(seed)
    var v = variantOf(seed)
    // 圆日：同安卓的比例
    var sunR = 13 + (v % 40) / 4            // 13 ~ 22.75
    var sunX = 30 + (v % 30)                // 30 ~ 59
    var sunY = 22 + (v % 17)                // 22 ~ 38
    var svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice">' +
      '<defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="' + p[1] + '"/><stop offset="1" stop-color="' + p[0] + '"/>' +
      '</linearGradient></defs>' +
      '<rect width="100" height="100" fill="url(#s)"/>' +
      '<circle cx="' + sunX + '" cy="' + sunY + '" r="' + sunR * 2 + '" fill="#F6EFD4" opacity="0.15"/>' +
      '<circle cx="' + sunX + '" cy="' + sunY + '" r="' + sunR + '" fill="#F6EFD4" opacity="0.95"/>' +
      '</svg>'
    return 'data:image/svg+xml,' + encodeURIComponent(svg)
  }

  /** 播放页氛围色：默认用歌名调色板（安卓提不出封面主色时也是这个回落） */
  function coverTheme(seed) {
    var c = hexToRgb(coverColors(seed)[0])
    return { h: rgbHue(c[0], c[1], c[2]), rgb: c }
  }
  function rgbHue(r, g, b) {
    r /= 255; g /= 255; b /= 255
    var max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min
    if (!d) return 0
    var h
    if (max === r) h = 60 * ((g - b) / d)
    else if (max === g) h = 60 * (2 + (b - r) / d)
    else h = 60 * (4 + (r - g) / d)
    return (h + 360) % 360
  }

  /**
   * 尝试从真封面位图提取主题色（安卓 extractCoverPalette 的思路）：
   * 缩小到 32×32 后按 12 个色相桶做「饱和度×明度」加权投票，死黑白不参与。
   * 跨域图片会被 canvas 拒绝，此时返回 null，由调用方回落到歌名调色板。
   */
  function extractTheme(url, cb) {
    if (!url) { cb(null); return }
    var img = new Image()
    img.crossOrigin = 'anonymous'
    var done = false
    var finish = function (h) { if (!done) { done = true; cb(h) } }
    img.onload = function () {
      try {
        var c = document.createElement('canvas')
        c.width = 32; c.height = 32
        var ctx = c.getContext('2d')
        ctx.drawImage(img, 0, 0, 32, 32)
        var d = ctx.getImageData(0, 0, 32, 32).data
        var w = new Array(12).fill(0), sr = new Array(12).fill(0), sg = new Array(12).fill(0), sb = new Array(12).fill(0)
        for (var i = 0; i < d.length; i += 4) {
          var r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255
          var mx = Math.max(r, g, b), mn = Math.min(r, g, b)
          var s = mx > 0 ? (mx - mn) / mx : 0
          if (mx < 0.12 || s < 0.15 || (mx > 0.96 && s < 0.10)) continue
          var hue = mx === mn ? 0 : mx === r ? 60 * (g - b) / (mx - mn)
            : mx === g ? 60 * (2 + (b - r) / (mx - mn)) : 60 * (4 + (r - g) / (mx - mn))
          var k = Math.min(11, Math.max(0, Math.floor((((hue % 360) + 360) % 360) / 30)))
          var wt = s * mx
          w[k] += wt; sr[k] += r * wt; sg[k] += g * wt; sb[k] += b * wt
        }
        var best = 0
        for (var j = 1; j < 12; j++) if (w[j] > w[best]) best = j
        if (w[best] <= 0) { finish(null); return }
        finish(rgbHue(sr[best] / w[best] * 255, sg[best] / w[best] * 255, sb[best] / w[best] * 255))
      } catch (e) { finish(null) }
    }
    img.onerror = function () { finish(null) }
    img.src = url
    setTimeout(function () { finish(null) }, 4000)
  }

  /** 真封面统一走 Worker 同源代理：canvas 可取色，也绕开防盗链 */
  function proxied(url) {
    if (!url) return ''
    if (url.indexOf('/api/cover-img') === 0) return url
    return '/api/cover-img?u=' + encodeURIComponent(url)
  }

  global.CoverArt = {
    colors: coverColors,
    generated: generatedCover,
    theme: coverTheme,
    extractTheme: extractTheme,
    proxied: proxied,
  }
})(window)
