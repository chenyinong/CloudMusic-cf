const CACHE = 'cloudmusic-cf-v7'
const PRECACHE = [
  '/', '/app.js', '/style.css', '/cover.js',
  '/m.html', '/m.css', '/m.js',
  '/icon.svg', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png', '/manifest.webmanifest',
]

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

/** 断网或超时（3 秒）时回退到缓存 */
function timeout(ms) {
  return new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))
}

self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url)
  if (e.request.method !== 'GET' || u.origin !== self.location.origin || u.pathname.startsWith('/api/')) return

  // 页面导航走 network-first：改了 index.html 立刻能看到，不再被缓存坑；
  // 离线时才回退到缓存的首页。
  if (e.request.mode === 'navigate' || u.pathname === '/') {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          if (res.ok) caches.open(CACHE).then((c) => c.put(e.request, res.clone()))
          return res
        })
        .catch(() => caches.match(e.request).then((h) => h || caches.match('/')))
    )
    return
  }

  // 静态资源（js / css / 图标）也走 network-first（3 秒超时兜底）：
  // 之前是 cache-first，部署新版本后 PWA 仍吃旧缓存，改样式看不到效果。
  // 联网时总能拿到最新文件，断网时回退缓存照常秒开。
  e.respondWith(
    (async () => {
      const cache = await caches.open(CACHE)
      try {
        const res = await Promise.race([fetch(e.request), timeout(3000)])
        if (res && res.ok) cache.put(e.request, res.clone())
        return res
      } catch {
        // 离线回退：先按完整 URL 找，再忽略查询串找（页面里用了 ?v=7 防缓存，
        // 而预缓存里是 /m.css 这种无参 URL）
        const hit = (await caches.match(e.request)) ||
          (await caches.match(e.request, { ignoreSearch: true }))
        if (hit) return hit
        throw new Error('offline and not cached')
      }
    })()
  )
})
