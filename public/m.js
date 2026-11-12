/* 云音乐移动版 —— 交互/视觉对齐安卓客户端；复用 /api/* 全部后端能力 */
const $ = (s) => document.querySelector(s)
const $$ = (s) => Array.from(document.querySelectorAll(s))
const audio = $('#audio')

const MODE = {
  order: { icon: 'i-repeat', label: '列表循环' },
  shuffle: { icon: 'i-shuffle', label: '随机播放' },
  repeat1: { icon: 'i-repeat-one', label: '单曲循环' },
}
function modeIcon(mode) { return `<svg><use href="#${MODE[mode].icon}"/></svg>` }
const PAGE_TITLE = { library: '我的收藏', playlist: '我的歌单', search: '搜歌', settings: '设置' }

const state = {
  playlist: loadJSON('cm.playlist'),
  /** 歌单集合：导入的歌单都进这里。「我的歌单」页展示，点开看歌曲 */
  plists: loadJSON('cm.plists') || [],
  detail: null,
  cookie: localStorage.getItem('cm.cookie') || '',
  index: -1,
  busy: false,
  resolved: null,
  favs: loadJSON('cm.favs') || [],
  playMode: localStorage.getItem('cm.playMode') || 'order',
  onlineLyric: localStorage.getItem('cm.onlineLyric') !== 'off',
  lyricOffset: Number(localStorage.getItem('cm.lyricOffset') || 0),
  sleep: null,
  tab: 'library',
  sort: 0,
  filter: '',
  account: loadJSON('cm.account'),
}
let lyricLines = []
let lyricActive = -1
let lyricKey = ''
let ppOpen = false
let ppView = 'cover'
let sheetTrack = null
const coverObservers = []
const coverCache = new Map()       // 会话内 Promise 去重（同一首歌并发只查一次）
const COVER_NEG_TTL = 7 * 24 * 3600 * 1000  // 负缓存 7 天，同安卓
const COVER_POS_TTL = 30 * 24 * 3600 * 1000 // 命中结果保留 30 天
function coverStore() { return loadJSON('cm.covers') || {} }
function saveCoverStore(s) { saveJSON('cm.covers', s) }

function loadJSON(k) { try { return JSON.parse(localStorage.getItem(k) || 'null') } catch { return null } }
function saveJSON(k, v) { localStorage.setItem(k, JSON.stringify(v)) }
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c])
}
function fmt(sec) {
  const n = Math.max(0, Math.floor(Number(sec) || 0))
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`
}
function toast(msg) {
  const el = $('#toast')
  el.textContent = msg
  el.hidden = false
  clearTimeout(toast._t)
  toast._t = setTimeout(() => { el.hidden = true }, 2200)
}
async function post(path, body) {
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const d = await r.json().catch(() => ({ error: '返回不是 JSON' }))
  if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`)
  return d
}
/** 带账号令牌的请求（登录后自动附加 Authorization），并处理 401 失效 */
async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' }
  if (state.account?.token) headers.Authorization = 'Bearer ' + state.account.token
  const r = await fetch(path, {
    method: opts.method || 'GET',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  if (r.status === 401) { logoutAccount(true); throw new Error('登录已失效，请重新登录') }
  const d = await r.json().catch(() => ({ error: '返回不是 JSON' }))
  if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`)
  return d
}
function current() { return state.playlist?.tracks?.[state.index] || null }
function coverKey(t) { return `${t?.title || ''}|${t?.artist || ''}` }
/** 同专辑判定：歌手 + 专辑（安卓是 provider+歌手+目录，网页版没有网盘维度） */
function albumKey(t) {
  const a = String(t?.artist || '').trim().toLowerCase()
  const b = String(t?.album || '').trim().toLowerCase()
  return a && b ? `${a}|${b}` : ''
}
function hue(s) { return CoverArt.theme(s).h }
/** 占位画：与安卓 GeneratedCover 同一张「天空 + 圆日 + 三层山影」 */
function placeholder(t) { return CoverArt.generated(t?.title || '?') }

/* ══════════ iOS Safari 音频解锁 ══════════
   iPhone 上 play() 必须在用户手势的同步调用栈里；我们的 playAt 要等
   /api/resolve 返回后才 play()，已脱离手势 → NotAllowedError。
   做法：首次任意手势时，给用户手势里给主 audio 元素播一段 0.05s 静音 wav，
   把这个元素「解锁」，之后换 src 再 play() 就允许了。另有 tap-to-play 兜底。 */
let unlocked = false
function silentWavUrl() {
  const rate = 8000, len = 400
  const buf = new ArrayBuffer(44 + len)
  const dv = new DataView(buf)
  const put = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)) }
  put(0, 'RIFF'); dv.setUint32(4, 36 + len, true); put(8, 'WAVE')
  put(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true)
  dv.setUint32(24, rate, true); dv.setUint32(28, rate, true)
  dv.setUint16(32, 1, true); dv.setUint16(34, 8, true)
  put(36, 'data'); dv.setUint32(40, len, true)
  for (let i = 0; i < len; i++) dv.setUint8(44 + i, 128)
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }))
}
function unlockAudio() {
  if (unlocked) return
  unlocked = true
  try {
    audio.muted = true
    audio.src = silentWavUrl()
    // 只复位 muted：静音源播完自然结束，真正的 src 由 playAt 覆盖，
    // 不能在这里清 src，否则会与「首次点击即点歌」竞态把真音源清掉。
    const p = audio.play()
    if (p && p.finally) p.finally(() => { audio.muted = false })
    else audio.muted = false
  } catch { audio.muted = false }
}
document.addEventListener('touchend', unlockAudio, { once: true, capture: true, passive: true })
document.addEventListener('click', unlockAudio, { once: true, capture: true })

/* ══════════ 主题 ══════════ */
function applyTheme() {
  const t = localStorage.getItem('cm.theme') || 'system'
  const dark = t === 'system' ? matchMedia('(prefers-color-scheme: dark)').matches : t === 'dark'
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light')
  const meta = $('meta[name="theme-color"]:not([media])')
  if (meta) meta.content = dark ? '#121212' : '#F5F6F8'
}

/* ══════════ 封面 ══════════
   对齐安卓 CoverRepository：元数据封面 → 持久化缓存 → 同专辑复用 → 后端来源链。
   命中/查无都落 localStorage，同一首歌终身只查一次；查无 7 天后允许重试。 */
function cachedCover(k) {
  const rec = coverStore()[k]
  if (!rec) return undefined
  const ttl = rec.url ? COVER_POS_TTL : COVER_NEG_TTL
  if (Date.now() - (rec.at || 0) > ttl) return undefined
  return rec.url || null
}
function storeCover(t, url, strict) {
  const s = coverStore()
  s[coverKey(t)] = { url: url || '', at: Date.now() }
  // 严格命中才可复用给同专辑其他歌，避免把宽松候选贴满整张专辑
  if (url && strict && albumKey(t)) s['@album:' + albumKey(t)] = { url, at: Date.now() }
  try { saveCoverStore(s) } catch { /* localStorage 满时忽略 */ }
}
function resolveCover(t) {
  const k = coverKey(t)
  if (coverCache.has(k)) return coverCache.get(k)
  const p = (async () => {
    // 1) 歌单/搜索元数据自带的封面，最准、零成本
    if (t.coverUrl) { storeCover(t, t.coverUrl, true); return t.coverUrl }
    // 2) 持久化缓存（含负缓存）
    const hit = cachedCover(k)
    if (hit !== undefined) return hit
    // 3) 同专辑复用
    const ak = albumKey(t)
    const reused = ak ? cachedCover('@album:' + ak) : undefined
    if (reused) { storeCover(t, reused, true); return reused }
    // 4) 后端来源链
    try {
      const d = await post('/api/cover', {
        title: t.title, artist: t.artist, album: t.album, coverUrl: t.coverUrl,
      })
      const url = d.url || null
      storeCover(t, url, !!d.strict)
      return url
    } catch {
      // 网络异常是临时失败，不落负缓存，下次还能重试
      return null
    }
  })()
  coverCache.set(k, p)
  return p
}
async function getCover(t) { return t ? resolveCover(t) : null }
function paintPlaceholder(el, t) {
  el.style.backgroundImage = `url("${placeholder(t)}")`
  el.style.backgroundSize = 'cover'
  el.style.backgroundPosition = 'center'
  const ph = el.querySelector('.cover-letter')
  if (ph) ph.hidden = true
}
function paintRealCover(el, t, url, k) {
  if (url && el.isConnected && el.dataset.ck === k && !el.querySelector('img')) {
    el.insertAdjacentHTML('afterbegin', `<img src="${esc(CoverArt.proxied(url))}" alt="" />`)
  }
}
function fillCover(el, t) {
  if (!el) return
  const k = coverKey(t)
  // 同一首歌重复调用（play/pause）直接跳过，避免删了又加导致封面闪一下
  if (el.dataset.ck === k && el.dataset.coverInit === '1') return
  el.dataset.ck = k
  el.dataset.coverInit = '1'
  const old = el.querySelector('img')
  if (old) old.remove()
  paintPlaceholder(el, t)
  getCover(t).then((url) => paintRealCover(el, t, url, k))
}
function observeCovers(root, tracks) {
  // 同一个容器重渲染时先释放旧 observer；不同容器各自独立，切 tab 互不影响
  const prev = coverObservers.find((o) => o.root === root)
  if (prev) { prev.io.disconnect(); coverObservers.splice(coverObservers.indexOf(prev), 1) }
  const els = root.querySelectorAll('.song-cover')
  els.forEach((el) => {
    const t = tracks[Number(el.dataset.i)]
    if (!t) return
    el.dataset.ck = coverKey(t)
    // 列表只画占位，不立刻发请求；封面等进入视口再取，避免一次上百个请求
    const old = el.querySelector('img')
    if (old) old.remove()
    paintPlaceholder(el, t)
  })
  if (!('IntersectionObserver' in window)) return
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue
      const el = e.target
      const t = tracks[Number(el.dataset.i)]
      if (t && !el.querySelector('img')) {
        getCover(t).then((url) => paintRealCover(el, t, url, coverKey(t)))
      }
      io.unobserve(el)
    }
  }, { rootMargin: '120px' })
  els.forEach((el) => io.observe(el))
  coverObservers.push({ root, io })
}

/* ══════════ 渲染 ══════════ */
function filteredTracks() {
  const list = state.favs
  const q = state.filter.trim().toLowerCase()
  let out = q
    ? list.filter((t) => [t.title, t.artist, t.album].some((v) => String(v || '').toLowerCase().includes(q)))
    : list.slice()
  if (state.sort === 1) out.sort((a, b) => String(a.title).localeCompare(String(b.title), 'zh'))
  if (state.sort === 2) out.sort((a, b) => String(a.artist).localeCompare(String(b.artist), 'zh'))
  return out
}
function songRow(t, i, opts = {}) {
  const sel = opts.active ?? (i === state.index && opts.from === 'library')
  return `
    <div class="song ${sel ? 'sel' : ''}" data-i="${i}">
      <div class="song-cover" data-i="${i}"></div>
      <div class="song-body">
        <div class="song-title">${esc(t.title)}</div>
        <div class="song-sub">${esc(t.artist || '未知歌手')}${t.album ? ' · ' + esc(t.album) : ''}</div>
      </div>
      ${opts.duration ? `<span class="muted" style="font-size:12px">${t.durationSec ? fmt(t.durationSec) : ''}</span>` : ''}
      <button class="song-more" data-more="${i}" aria-label="更多"><svg><use href="#i-more"/></svg></button>
    </div>`
}
function emptyBox(text) {
  return `<div class="empty"><svg><use href="#i-music"/></svg>${esc(text)}</div>`
}
/** 「我的」页 = 收藏（小红心）的歌 */
function renderLibrary() {
  const list = state.favs
  const artists = new Set(list.map((t) => String(t.artist || '').trim()).filter(Boolean)).size
  const albums = new Set(list.map((t) => String(t.album || '').trim()).filter(Boolean)).size
  $('#hero-count').textContent = list.length
  $('#hero-source').textContent = `${artists} 位歌手`
  $('#hero-artist').textContent = `${albums} 张专辑`
  const f = filteredTracks()
  $('#lib-count').textContent = `${f.length} 首歌曲`
  $('#sort-label').textContent = ['默认', '按标题', '按歌手'][state.sort]
  const root = $('#tracks')
  if (!f.length) {
    root.innerHTML = emptyBox(list.length ? '没有匹配的歌曲' : '还没有收藏，在播放页点右上角小爱心即可收藏')
    return
  }
  root.innerHTML = f.map((t, i) => songRow(t, i, {
    active: t === state.playlist?.tracks?.[state.index], duration: true,
  })).join('')
  bindSongRows(root, f)
  observeCovers(root, f)
}
function bindSongRows(root, list, opts = {}) {
  root.querySelectorAll('.song').forEach((el) => {
    el.addEventListener('click', (e) => {
      const more = e.target.closest('[data-more]')
      if (more) { openSongSheet(list[Number(more.dataset.more)]); return }
      playFromList(list, Number(el.dataset.i), opts.name)
    })
  })
}
function playFromList(list, i, name) {
  // 列表可能被过滤/排序/来自搜索结果：整体作为播放队列，与安卓 play(filtered, i) 一致
  setPlaylist({ name: name || state.playlist?.name || '播放列表', platform: list[0]?.platform || 'netease', id: 'temp', tracks: list }, i)
}
function renderAll() {
  renderLibrary()
  renderPlists()
  renderMini()
  renderQuarkState()
}

/* ══════════ 歌单集合（本地 + 云端） ══════════ */
function savePlists() {
  // 已同步的歌单只留元数据，歌曲列表在云端，点开时按需拉取
  saveJSON('cm.plists', state.plists.map((p) => (p.synced
    ? { id: p.id, cloudId: p.cloudId, name: p.name, platform: p.platform, count: p.count, updatedAt: p.updatedAt, synced: true }
    : p)))
}
function renderPlists() {
  const root = $('#plist-list')
  if (!root) return
  if (!state.plists.length) {
    root.innerHTML = emptyBox('还没有歌单，在上方导入一张')
    return
  }
  root.innerHTML = state.plists.map((p) => `
    <div class="pli" data-id="${esc(p.id)}">
      <div class="pli-cover"></div>
      <div class="pli-main">
        <div class="pli-title">${esc(p.name)}</div>
        <div class="pli-sub">${esc(p.platform === 'qq' ? 'QQ 音乐' : '网易云')} · ${p.count || 0} 首 · ${p.synced ? '云端' : '本机'}</div>
      </div>
      <button class="pli-act" data-act="open" data-id="${esc(p.id)}">打开</button>
      <button class="pli-act danger" data-act="del" data-id="${esc(p.id)}">删除</button>
    </div>`).join('')
  root.querySelectorAll('.pli-cover').forEach((el) => {
    const p = state.plists.find((x) => x.id === el.parentElement.dataset.id)
    if (p) el.style.backgroundImage = `url("${CoverArt.generated(p.name)}")`
  })
  root.querySelectorAll('[data-act]').forEach((b) =>
    b.addEventListener('click', (e) => {
      e.stopPropagation()
      if (b.dataset.act === 'open') openPlaylist(b.dataset.id)
      else deletePlaylist(b.dataset.id)
    }))
  root.querySelectorAll('.pli').forEach((el) =>
    el.addEventListener('click', () => openPlaylist(el.dataset.id)))
}
async function openPlaylist(id) {
  const p = state.plists.find((x) => x.id === id)
  if (!p) return
  if (p.synced && !p.tracks?.length) {
    if (!state.account?.token) { toast('云端歌单需要先登录账号'); return }
    try {
      const d = await api('/api/playlists/' + p.cloudId)
      p.tracks = JSON.parse(d.tracks)
      p.count = p.tracks.length
    } catch (e) { toast('读取云端歌单失败：' + e.message); return }
  }
  state.detail = p
  renderDetail()
  showDetailPage()
}
function renderDetail() {
  const p = state.detail
  if (!p) return
  $('#pl-title').textContent = p.name
  $('#pl-meta').textContent = `${p.platform === 'qq' ? 'QQ 音乐' : '网易云'} · ${p.tracks?.length || 0} 首${p.synced ? ' · 已同步到云端' : ' · 仅本机'}`
  const root = $('#pl-tracks')
  if (!p.tracks?.length) { root.innerHTML = emptyBox('这个歌单还没有歌曲'); return }
  root.innerHTML = p.tracks.map((t, i) => songRow(t, i, { active: false, duration: true })).join('')
  bindSongRows(root, p.tracks, { name: p.name })
  observeCovers(root, p.tracks)
}
async function deletePlaylist(id) {
  const p = state.plists.find((x) => x.id === id)
  if (!p) return
  if (!confirm(`删除歌单「${p.name}」？`)) return
  if (p.synced && p.cloudId) {
    if (!state.account?.token) { toast('请先登录账号再删除云端歌单'); return }
    try { await api('/api/playlists/' + p.cloudId, { method: 'DELETE' }) }
    catch (e) { toast('删除云端歌单失败：' + e.message); return }
  }
  state.plists = state.plists.filter((x) => x.id !== id)
  savePlists()
  renderPlists()
  toast('已删除')
}
/** 导入的歌单进集合；已登录则同时存到云端 */
async function addPlaylist(pl) {
  let item
  if (state.account?.token) {
    try {
      const d = await api('/api/playlists', { method: 'POST', body: { name: pl.name, platform: pl.platform, tracks: pl.tracks } })
      item = { id: 'c' + d.id, cloudId: d.id, name: pl.name, platform: pl.platform, count: pl.tracks.length, updatedAt: Date.now(), synced: true }
    } catch {
      toast('云端保存失败，已存在本机')
      item = { id: 'l' + Date.now(), name: pl.name, platform: pl.platform, count: pl.tracks.length, updatedAt: Date.now(), synced: false, tracks: pl.tracks }
    }
  } else {
    item = { id: 'l' + Date.now(), name: pl.name, platform: pl.platform, count: pl.tracks.length, updatedAt: Date.now(), synced: false, tracks: pl.tracks }
  }
  state.plists.unshift(item)
  savePlists()
  renderPlists()
  return item
}
/** 登录后把本机尚未同步的歌单补传云端 */
async function syncLocalLists(verbose = false) {
  const pending = state.plists.filter((p) => !p.synced && p.tracks?.length)
  if (!pending.length) { if (verbose) toast('没有需要同步的歌单'); return }
  let ok = 0
  for (const p of pending) {
    try {
      const d = await api('/api/playlists', { method: 'POST', body: { name: p.name, platform: p.platform, tracks: p.tracks } })
      p.id = 'c' + d.id
      p.cloudId = d.id
      p.synced = true
      p.updatedAt = Date.now()
      delete p.tracks
      ok++
    } catch { /* 保留在本机 */ }
  }
  savePlists()
  renderPlists()
  toast(ok ? `已同步 ${ok} 张歌单到云端` : '同步失败，请稍后再试')
}
/** 拉取云端歌单并合并进集合；同名同平台的本机歌单视为已同步，避免重复 */
async function loadCloudLists() {
  if (!state.account?.token) return
  try {
    const list = await api('/api/playlists')
    for (const p of list) {
      const cid = 'c' + p.id
      let exist = state.plists.find((x) => x.cloudId === p.id)
      if (!exist) exist = state.plists.find((x) => !x.synced && x.name === p.name && x.platform === p.platform)
      if (exist) {
        exist.cloudId = p.id
        exist.id = cid
        exist.synced = true
        exist.count = p.count ?? exist.count
        exist.updatedAt = p.updated_at || exist.updatedAt
        delete exist.tracks
      } else {
        state.plists.unshift({
          id: cid, cloudId: p.id, name: p.name, platform: p.platform,
          count: p.count || 0, updatedAt: p.updated_at || Date.now(), synced: true,
        })
      }
    }
    savePlists()
    renderPlists()
  } catch (e) { toast('读取云端歌单失败：' + e.message) }
}

function renderMini() {
  const t = current()
  const mini = $('#mini')
  mini.hidden = !t
  if (!t) return
  $('#mini-text').textContent = `${t.title}${t.artist ? ' - ' + t.artist : ''}`
  const cover = $('#mini-cover')
  fillCover(cover, t)
  cover.classList.toggle('spin', !audio.paused)
  cover.classList.toggle('paused', audio.paused)
  $('#mini-play').innerHTML = `<svg><use href="#${audio.paused ? 'i-play' : 'i-pause'}"/></svg>`
}
function setPlayIcon() {
  $('#mini-play').innerHTML = `<svg><use href="#${audio.paused ? 'i-play' : 'i-pause'}"/></svg>`
  $('#pp-play').innerHTML = `<svg><use href="#${audio.paused ? 'i-play' : 'i-pause'}"/></svg>`
  const c = $('#mini-cover')
  c.classList.toggle('spin', !audio.paused)
  c.classList.toggle('paused', audio.paused)
}

/* ══════════ 播放 ══════════ */
function setPlaylist(pl, idx) {
  state.playlist = pl
  saveJSON('cm.playlist', pl)
  playAt(idx)
}
async function playAt(i) {
  const pl = state.playlist
  if (!pl || !pl.tracks[i] || state.busy) return
  state.busy = true
  state.index = i
  state.resolved = null
  toast('正在找完整版…')
  renderLibrary()
  renderMini()
  const t = pl.tracks[i]
  try {
    const d = await post('/api/resolve', {
      title: t.title, artist: t.artist, durationSec: t.durationSec,
      platformId: t.platformId, cookie: state.cookie,
    })
    if (!d.ok || !d.resolved) { toast(d.error || '没找到可播放的音源'); return }
    state.resolved = d.resolved
    onTrackChanged(t)
    audio.src = d.resolved.url
    try {
      await audio.play()
    } catch (e) {
      if (/NotAllowed/i.test(String(e?.name || e))) $('#tap-to-play').hidden = false
      else toast('播放失败：' + (e.message || '直链可能已失效'))
    }
    toast(d.resolved.partial ? '只有试听片段，建议登录夸克' : '正在播放完整版')
    updateMediaSession(t)
  } catch (e) {
    toast('解析失败：' + e.message)
  } finally {
    state.busy = false
    renderLibrary()
    renderMini()
  }
}
function onTrackChanged(t) {
  lyricLines = []
  lyricActive = -1
  lyricKey = ''
  $('#pp-lyric-inner').innerHTML = ''
  syncPlayer()
  if (ppView === 'lyric') ensureLyric()
}
function step(delta) {
  const n = state.playlist?.tracks?.length ?? 0
  if (!n) return
  let next
  if (state.playMode === 'repeat1') next = (state.index + delta + n) % n
  else if (state.playMode === 'shuffle') {
    next = state.index
    if (n > 1) while (next === state.index) next = Math.floor(Math.random() * n)
  } else next = (state.index + delta + n) % n
  playAt(next)
}
function updateMediaSession(t) {
  if (!('mediaSession' in navigator) || !('MediaMetadata' in window)) return
  navigator.mediaSession.metadata = new MediaMetadata({
    title: t.title, artist: t.artist || '未知歌手', album: t.album || '',
    artwork: [{ src: '/icon.svg', sizes: '512x512', type: 'image/svg+xml' }],
  })
  getCover(t).then((url) => {
    if (url && current() === t) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: t.title, artist: t.artist || '', album: t.album || '',
        artwork: [{ src: url, sizes: '512x512', type: 'image/jpeg' }],
      })
    }
  })
  try {
    navigator.mediaSession.setActionHandler('play', () => audio.play())
    navigator.mediaSession.setActionHandler('pause', () => audio.pause())
    navigator.mediaSession.setActionHandler('previoustrack', () => step(-1))
    navigator.mediaSession.setActionHandler('nexttrack', () => step(1))
  } catch { /* 部分浏览器不支持 */ }
}

/* ══════════ 歌词 ══════════ */
function parseLrc(text) {
  if (!text) return []
  const out = []
  const re = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g
  for (const line of String(text).split('\n')) {
    re.lastIndex = 0
    const tags = []
    let m
    while ((m = re.exec(line)) !== null) tags.push(m)
    if (!tags.length) continue
    const txt = line.replace(re, '').trim()
    for (const t of tags) {
      out.push({ time: Number(t[1]) * 60 + Number(t[2]) + (t[3] ? Number(t[3].padEnd(3, '0')) / 1000 : 0), text: txt })
    }
  }
  return out.sort((a, b) => a.time - b.time)
}
function paintLyric(lines) {
  const inner = $('#pp-lyric-inner')
  if (!lines.length) { inner.innerHTML = '<div class="pp-lyric-none">暂无歌词</div>'; return }
  inner.innerHTML = lines.map((l, i) => `<div class="pp-lyric-line" data-i="${i}">${esc(l.text) || '·'}</div>`).join('')
  inner.querySelectorAll('.pp-lyric-line').forEach((node) => {
    node.addEventListener('click', (e) => {
      e.stopPropagation()
      const t = lines[Number(node.dataset.i)]?.time
      if (Number.isFinite(t)) audio.currentTime = Math.max(0, t - state.lyricOffset / 1000)
    })
  })
}
async function ensureLyric() {
  const t = current()
  if (!t || lyricKey === coverKey(t)) return
  lyricKey = coverKey(t)
  const inner = $('#pp-lyric-inner')
  if (!state.onlineLyric) { inner.innerHTML = '<div class="pp-lyric-none">已关闭在线歌词</div>'; return }
  inner.innerHTML = '<div class="pp-lyric-loading">歌词加载中…</div>'
  try {
    const d = await post('/api/lyric', {
      title: t.title, artist: t.artist, platform: t.platform, platformId: t.platformId,
    })
    if (lyricKey !== coverKey(t)) return
    lyricLines = parseLrc(d.lyric)
    lyricActive = -1
    paintLyric(lyricLines)
  } catch { inner.innerHTML = '<div class="pp-lyric-none">歌词获取失败</div>' }
}
function highlightLyric() {
  if (!lyricLines.length) return
  const cur = audio.currentTime + state.lyricOffset / 1000
  let i = lyricActive
  while (i + 1 < lyricLines.length && lyricLines[i + 1].time <= cur) i++
  while (i > 0 && lyricLines[i].time > cur) i--
  if (i === lyricActive) return
  lyricActive = i
  const inner = $('#pp-lyric-inner')
  const nodes = inner.children
  for (const c of nodes) c.classList.remove('active')
  const active = nodes[i]
  if (!active) return
  active.classList.add('active')
  if (ppOpen && ppView === 'lyric') {
    // 手动算 scrollTop，避免 scrollIntoView 连带滚动横向 pager
    inner.scrollTo({ top: active.offsetTop - inner.clientHeight / 2 + active.offsetHeight / 2, behavior: 'smooth' })
  }
}

/* ══════════ 全屏播放页 ══════════ */
function openPlayer() {
  if (!current()) return
  ppOpen = true
  $('#player').hidden = false
  syncPlayer()
  setView('lyric', true) // 安卓：从迷你条进来直接停在歌词页
}
function closePlayer() { ppOpen = false; $('#player').hidden = true }
function setView(v, instant) {
  ppView = v
  const pager = $('#pp-pager')
  pager.scrollTo({ left: v === 'cover' ? 0 : pager.clientWidth, behavior: instant ? 'auto' : 'smooth' })
  $$('.pp-dot').forEach((d) => d.classList.toggle('active', d.dataset.view === v))
  if (v === 'lyric') ensureLyric()
}
/** 播放页氛围底：三层叠加（表面色 → 淡彩渐变 → 白色渐隐蒙版），同安卓 songAmbientBackground */
function setAmbientHue(h) {
  const dark = document.documentElement.getAttribute('data-theme') === 'dark'
  const s = dark ? '28,28,30' : '255,255,255'
  $('#pp-bg').style.background =
    `linear-gradient(180deg, rgba(${s},.80) 0%, rgba(${s},.40) 45%, rgba(${s},0) 100%),` +
    `linear-gradient(180deg, hsla(${h},42%,52%,.20) 0%, hsla(${h},42%,52%,.32) 50%, ` +
    `hsla(${(h + 25) % 360},40%,48%,.44) 100%), var(--surface)`
}
/** 有真封面就从位图提主色；跨域取色失败或黑白封面则保持歌名调色板（安卓同款回落） */
function applyAmbient(t) {
  const fallback = hue(t?.title)
  setAmbientHue(fallback)
  if (!t) return
  getCover(t).then((url) => {
    if (!url || current() !== t) return
    CoverArt.extractTheme(CoverArt.proxied(url), (h) => {
      if (h !== null && current() === t) setAmbientHue(h)
    })
  })
}
function syncPlayer() {
  const t = current()
  const r = state.resolved
  $('#pp-title').textContent = t ? t.title : '未在播放'
  $('#pp-artist').textContent = t ? (t.artist || '未知歌手') : ''
  $('#pp-artist-oncover').textContent = t ? (t.artist || t.title) : ''
  $('#pp-source').textContent = r ? `${r.source} · ${r.partial ? '试听片段' : '原音质'}` : ''
  const n = state.playlist?.tracks?.length || 0
  $('#pp-index').textContent = n ? `${String(state.index + 1).padStart(2, '0')} / ${String(n).padStart(2, '0')}` : ''
  const cover = $('#pp-cover')
  fillCover(cover, t)
  applyAmbient(t)
  $('#pp-fav').classList.toggle('on', isFav(t))
  $('#pp-mode').innerHTML = modeIcon(state.playMode)
  setPlayIcon()
  syncTime()
  renderSleep()
}
function isFav(t) { return !!t && state.favs.some((f) => f.key === t.key) }
function toggleFav() {
  const t = current()
  if (!t) return
  const i = state.favs.findIndex((f) => f.key === t.key)
  if (i >= 0) { state.favs.splice(i, 1); toast('已取消收藏') }
  else { state.favs.unshift({ ...t }); toast('已收藏') }
  saveJSON('cm.favs', state.favs)
  $('#pp-fav').classList.toggle('on', isFav(t))
  renderLibrary()
}
function syncTime() {
  const d = audio.duration
  const ok = Number.isFinite(d) && d > 0
  $('#pp-cur').textContent = fmt(audio.currentTime)
  $('#pp-total').textContent = ok ? fmt(d) : '0:00'
  if (ok) $('#pp-seek').value = String(Math.round(audio.currentTime / d * 1000))
  const fill = $('#mini-progress-fill')
  if (fill) fill.style.width = ok ? `${(audio.currentTime / d * 100).toFixed(2)}%` : '0%'
}

/* ══════════ 定时关闭 ══════════ */
function setSleep(type, minutes) {
  state.sleep = type === 'track' ? { type: 'track' } : { type: 'time', endsAt: Date.now() + minutes * 60000 }
  renderSleep()
  toast(type === 'track' ? '已设置：播完本曲后停止' : `已设置：${minutes} 分钟后停止`)
}
function stopSleep() { state.sleep = null; $('#pp-sleep').textContent = '' }
function renderSleep() {
  const el = $('#pp-sleep')
  if (!state.sleep) { el.textContent = ''; return }
  if (state.sleep.type === 'track') { el.textContent = '定时关闭：播完本曲后停止'; return }
  el.textContent = `定时关闭：剩 ${fmt((state.sleep.endsAt - Date.now()) / 1000)}`
}

/* ══════════ 弹层 ══════════ */
function openSongSheet(t) {
  if (!t) return
  sheetTrack = t
  const box = $('#sheet .sheet-box')
  $('#sheet-head').textContent = `${t.title} · ${t.artist || '未知歌手'}`
  box.innerHTML = `
    <button class="sheet-item" data-act="play">播放这首</button>
    <button class="sheet-item" data-act="favthis">${state.favs.some((f) => f.key === t.key) ? '取消收藏' : '收藏这首'}</button>
    <button class="sheet-item" data-act="infothis">歌曲信息</button>
    <button class="sheet-item cancel" data-close>取消</button>`
  $('#sheet').hidden = false
}
function openPlayerSheet() {
  sheetTrack = null
  const t = current()
  const box = $('#sheet .sheet-box')
  $('#sheet-head').textContent = t ? `${t.title} · ${t.artist || ''}` : '播放'
  box.innerHTML = `
    <button class="sheet-item" data-act="info">歌曲信息</button>
    <button class="sheet-item" data-act="queue">播放列表</button>
    <button class="sheet-item" data-act="sleep15">定时关闭 · 15 分钟</button>
    <button class="sheet-item" data-act="sleep30">定时关闭 · 30 分钟</button>
    <button class="sheet-item" data-act="sleep60">定时关闭 · 60 分钟</button>
    <button class="sheet-item" data-act="sleeptrack">定时关闭 · 播完本曲</button>
    <button class="sheet-item" data-act="relyric">重新匹配歌词</button>
    <button class="sheet-item" data-act="searchlyric">手动搜索歌词</button>
    <button class="sheet-item" data-act="offset-">歌词快退 0.5 秒</button>
    <button class="sheet-item" data-act="offset+">歌词快进 0.5 秒</button>
    <button class="sheet-item" data-act="fav">收藏 / 取消收藏</button>
    <button class="sheet-item cancel" data-close>取消</button>`
  $('#sheet').hidden = false
}
function closeSheet() { $('#sheet').hidden = true }
function showInfo(t) {
  if (!t) return
  const r = t === current() ? state.resolved : null
  $('#info-body').innerHTML = `
    <div class="info-row"><span>歌名</span><b>${esc(t.title)}</b></div>
    <div class="info-row"><span>歌手</span><b>${esc(t.artist || '未知歌手')}</b></div>
    <div class="info-row"><span>专辑</span><b>${esc(t.album || '—')}</b></div>
    <div class="info-row"><span>时长</span><b>${t.durationSec ? fmt(t.durationSec) : '—'}</b></div>
    <div class="info-row"><span>来源</span><b>${esc(t.platform || '—')}</b></div>
    <div class="info-row"><span>音源</span><b>${r ? esc(r.source) + (r.partial ? '（试听片段）' : '') : '—'}</b></div>`
  $('#modal-info').hidden = false
}
function showQueue() {
  const list = state.playlist?.tracks || []
  $('#queue-count').textContent = list.length
  const root = $('#queue-list')
  if (!list.length) { root.innerHTML = emptyBox('没有播放列表'); }
  else {
    root.innerHTML = list.map((t, i) => `
      <div class="song ${i === state.index ? 'sel' : ''}" data-i="${i}">
        <div class="song-cover" data-i="${i}"></div>
        <div class="song-body"><div class="song-title">${esc(t.title)}</div>
        <div class="song-sub">${esc(t.artist || '未知歌手')}</div></div>
      </div>`).join('')
    root.querySelectorAll('.song').forEach((el) =>
      el.addEventListener('click', () => { playAt(Number(el.dataset.i)); $('#modal-queue').hidden = true }))
    observeCovers(root, list)
  }
  $('#modal-queue').hidden = false
}
function adjustOffset(delta) {
  state.lyricOffset += delta
  localStorage.setItem('cm.lyricOffset', String(state.lyricOffset))
  lyricActive = -1
  toast(state.lyricOffset >= 0 ? `歌词快进 ${state.lyricOffset / 1000}s` : `歌词快退 ${-state.lyricOffset / 1000}s`)
}
async function runManualLyric() {
  const title = $('#ls-title').value.trim()
  const artist = $('#ls-artist').value.trim()
  if (!title) return
  $('#modal-lyric').hidden = true
  const inner = $('#pp-lyric-inner')
  inner.innerHTML = '<div class="pp-lyric-loading">歌词加载中…</div>'
  try {
    const d = await post('/api/lyric', { title, artist })
    lyricLines = parseLrc(d.lyric)
    lyricActive = -1
    lyricKey = coverKey(current())
    paintLyric(lyricLines)
  } catch { inner.innerHTML = '<div class="pp-lyric-none">歌词获取失败</div>' }
}

/* ══════════ Tab / 页面 ══════════ */
function switchTab(tab) {
  state.tab = tab
  state.detail = null
  $$('.page').forEach((p) => { p.hidden = p.dataset.page !== tab })
  $$('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab))
  $('#page-title').textContent = PAGE_TITLE[tab]
  $('#bar-settings').hidden = tab === 'settings'
  $('#bar-refresh').hidden = tab !== 'library'
  $('#pages').scrollTop = 0
}
/** 歌单详情：不属于任何 Tab，返回按钮回到「歌单」 */
function showDetailPage() {
  $$('.page').forEach((p) => { p.hidden = p.dataset.page !== 'detail' })
  $$('.tab').forEach((b) => b.classList.remove('active'))
  $('#page-title').textContent = state.detail?.name || '歌单'
  $('#bar-settings').hidden = true
  $('#bar-refresh').hidden = true
  $('#pages').scrollTop = 0
}

/* ══════════ 夸克登录 ══════════ */
function renderQuarkState() {
  const on = !!state.cookie
  const badge = `<span class="badge ${on ? '' : 'off'}">${on ? '已登录' : '未登录'}</span>`
  const setBadge = $('#set-quark-badge')
  setBadge.className = `badge ${on ? '' : 'off'}`
  setBadge.textContent = on ? '已登录' : '未登录'
  $('#set-quark-sub').textContent = on ? '可用完整版音源' : '未登录 · 只能听公开音源'
  const lb = $('#login-badge')
  lb.className = `badge ${on ? '' : 'off'}`
  lb.textContent = on ? '已登录' : '未登录'
  $('#login-state').textContent = on ? '已登录 · 可听完整版' : '未登录 · 只能听公开音源'
  $('#l-cookie').value = state.cookie
  $('#set-cookie').value = state.cookie
}
/* ══════════ 夸克 Cookie 云端同步 ══════════ */
/** 保存本机 Cookie 并记下时间戳（用来和云端比新旧） */
function saveCookieLocal(cookie) {
  state.cookie = cookie || ''
  localStorage.setItem('cm.cookie', state.cookie)
  localStorage.setItem('cm.cookieAt', String(Date.now()))
}
/** 把本机 Cookie 上传云端（覆盖旧的）；返回是否成功 */
async function uploadCookie() {
  if (!state.account?.token || !state.cookie) return false
  try {
    await api('/api/settings/quark', { method: 'POST', body: { cookie: state.cookie } })
    return true
  } catch { return false }
}
/** 登录后把云端 Cookie 取回来：谁新用谁；本机更新就回写覆盖云端 */
async function syncCookieFromCloud() {
  if (!state.account?.token) return
  try {
    const d = await api('/api/settings/quark')
    const cloud = d?.cookie || ''
    const cloudAt = Number(d?.updatedAt || 0)
    if (!cloud) {
      if (state.cookie) await uploadCookie()   // 云端没有、本机有 → 传上去
      return
    }
    const localAt = Number(localStorage.getItem('cm.cookieAt') || 0)
    if (localAt > cloudAt && state.cookie && state.cookie !== cloud) {
      await uploadCookie()                     // 本机是新的 → 覆盖云端
      return
    }
    if (state.cookie !== cloud) {
      state.cookie = cloud
      localStorage.setItem('cm.cookie', cloud)
      localStorage.setItem('cm.cookieAt', String(cloudAt || Date.now()))
      renderQuarkState()
      toast('已从云端恢复夸克 Cookie')
    }
  } catch { /* 云端取不到就继续用本机的 */ }
}

let loginTimer = null
async function beginQuarkLogin(prefix) {
  const btn = $(`#${prefix}-qr`)
  const status = $(prefix === 'l' ? '#login-state' : '#set-quark-sub')
  const box = $(`#${prefix}-qr-box`)
  const img = $(`#${prefix}-qr-img`)
  btn.disabled = true
  status.textContent = '正在获取登录二维码…'
  if (loginTimer) { clearInterval(loginTimer); loginTimer = null }
  try {
    const d = await post('/api/quark/login/start', {})
    img.src = d.qrImage
    if (prefix === 'l') $('#l-qr-link').href = d.qrText
    box.hidden = false
    status.textContent = '等待扫码…'
    let tries = 0
    const started = Date.now()
    loginTimer = setInterval(async () => {
      tries++
      if (tries > 200) {
        clearInterval(loginTimer); loginTimer = null
        status.textContent = '二维码可能已失效，请重新点扫码登录'
        return
      }
      try {
        const r = await post('/api/quark/login/poll', { loginToken: d.loginToken })
        if (r.status === 'ok') {
          clearInterval(loginTimer); loginTimer = null
          saveCookieLocal(r.cookie || '')
          box.hidden = true
          status.textContent = `登录成功${r.account ? '：' + r.account : ''}`
          renderQuarkState()
          const synced = await uploadCookie()
          toast(synced ? '夸克登录成功，Cookie 已同步到云端' : '夸克登录成功，可听完整版')
        } else if (r.status === 'expired') {
          clearInterval(loginTimer); loginTimer = null
          status.textContent = r.message || '二维码已过期，重新点一次'
        } else {
          const s = Math.floor((Date.now() - started) / 1000)
          status.textContent = s > 120 ? '二维码可能已失效，建议在手机确认后重扫' : `等待扫码或手机确认…（${s}s）`
        }
      } catch (e) { status.textContent = `轮询失败：${e.message}` }
    }, 3000)
  } catch (e) {
    status.textContent = `获取二维码失败：${e.message}`
  } finally { btn.disabled = false }
}
function showApp() {
  $('#login').hidden = true
  $('#app').hidden = false
  switchTab('library')
  renderAll()
}
function showLogin() {
  $('#app').hidden = true
  $('#login').hidden = false
  renderQuarkState()
  renderLoginAccount()
}
/** 登录页顶部的账号状态徽标 */
function renderLoginAccount() {
  const b = $('#l-acc-badge')
  if (!b) return
  if (state.account?.token) {
    b.textContent = '已登录'
    b.className = 'badge'
  } else {
    b.textContent = '未登录'
    b.className = 'badge off'
  }
}
/** 在登录页直接用账号登录，登录后直接进入主界面 */
function loginAccountFromLogin() {
  const msg = $('#l-acc-msg')
  msg.textContent = ''
  const username = $('#l-acc-user').value.trim()
  const password = $('#l-acc-pass').value
  if (!username || !password) { msg.textContent = '用户名和密码都要填'; return }
  api('/api/auth/login', { method: 'POST', body: { username, password } })
    .then(async (d) => {
      state.account = { token: d.token, username: d.username }
      saveJSON('cm.account', state.account)
      localStorage.setItem('cm.loggedIn', '1')
      $('#l-acc-pass').value = ''
      showApp()
      renderAccount()
      toast('登录成功，可同步歌单了')
      await syncCookieFromCloud()
      await loadCloudLists()
      await syncLocalLists()
    })
    .catch((e) => { msg.textContent = e.message })
}

/* ══════════ 事件绑定 ══════════ */
$$('.tab').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)))
$('#bar-settings').addEventListener('click', () => switchTab('settings'))
$('#bar-refresh').addEventListener('click', () => {
  state.playlist = loadJSON('cm.playlist')
  renderAll()
  toast('曲库已重新载入')
})

// 曲库
$('#lib-search').addEventListener('input', (e) => { state.filter = e.target.value; renderLibrary() })
$('#lib-sort').addEventListener('click', () => { state.sort = (state.sort + 1) % 3; renderLibrary() })
$('#play-all').addEventListener('click', () => {
  const f = filteredTracks()
  if (f.length) playFromList(f, 0, '我的收藏')
})

// 歌单详情
$('#pl-back').addEventListener('click', () => switchTab('playlist'))
$('#pl-play-all').addEventListener('click', () => {
  const p = state.detail
  if (p?.tracks?.length) playFromList(p.tracks, 0, p.name)
})

// 歌单导入
async function importPlaylist() {
  const input = $('#pl-input').value.trim()
  if (!input) { toast('先贴一个歌单链接或 id'); return }
  const btn = $('#pl-import')
  btn.disabled = true
  toast('正在拉歌单…')
  try {
    const pl = await post('/api/playlist', { input, platform: $('#pl-platform').value || undefined })
    state.playlist = pl
    state.index = -1
    state.resolved = null
    saveJSON('cm.playlist', pl)
    await addPlaylist(pl)
    renderAll()
    toast(state.account?.token
      ? `导入成功，共 ${pl.tracks.length} 首，已同步到云端`
      : `导入成功，共 ${pl.tracks.length} 首（登录账号可自动同步云端）`)
    switchTab('playlist')
  } catch (e) { toast('导入失败：' + e.message) }
  finally { btn.disabled = false }
}
$('#pl-import').addEventListener('click', importPlaylist)
$('#pl-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') importPlaylist() })

// 搜歌
async function doSearch() {
  const kw = $('#search-input').value.trim()
  if (!kw) return
  const root = $('#search-results')
  root.innerHTML = '<div class="empty">搜索中…</div>'
  try {
    const d = await post('/api/search', { keyword: kw })
    const tracks = d.tracks || []
    if (!tracks.length) { root.innerHTML = emptyBox('没搜到结果'); return }
    root.innerHTML = tracks.map((t, i) => songRow(t, i, { active: false, duration: true })).join('')
    bindSongRows(root, tracks)
    observeCovers(root, tracks)
  } catch (e) { root.innerHTML = emptyBox('搜索失败：' + e.message) }
}
$('#search-go').addEventListener('click', doSearch)
$('#search-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.target.blur(); doSearch() } })

// 设置
$('#set-qr').addEventListener('click', () => beginQuarkLogin('set'))
$('#l-qr').addEventListener('click', () => beginQuarkLogin('l'))
$('#set-save').addEventListener('click', async () => {
  saveCookieLocal($('#set-cookie').value.trim())
  renderQuarkState()
  if (!state.cookie) { toast('已清空 Cookie'); return }
  const synced = await uploadCookie()
  toast(synced ? 'Cookie 已保存并同步到云端' : 'Cookie 已保存')
})
$('#set-theme').addEventListener('change', (e) => {
  localStorage.setItem('cm.theme', e.target.value)
  applyTheme()
})
$('#set-online-lyric').addEventListener('change', (e) => {
  state.onlineLyric = e.target.checked
  localStorage.setItem('cm.onlineLyric', state.onlineLyric ? 'on' : 'off')
  if (!state.onlineLyric) { lyricLines = []; $('#pp-lyric-inner').innerHTML = '' }
})
$('#set-rescan').addEventListener('click', () => { state.playlist = loadJSON('cm.playlist'); renderAll(); toast('曲库已重新载入') })
$('#set-clear').addEventListener('click', () => {
  if (!confirm('清除本机保存的歌单、Cookie 和收藏？')) return
  Object.keys(localStorage).filter((k) => k.startsWith('cm.')).forEach((k) => localStorage.removeItem(k))
  location.reload()
})
$('#set-desktop').addEventListener('click', () => { sessionStorage.setItem('cm.desktop', '1'); location.href = '/' })

// 登录页
$('#l-enter').addEventListener('click', async () => {
  saveCookieLocal($('#l-cookie').value.trim())
  localStorage.setItem('cm.loggedIn', '1')
  showApp()
  if (state.account?.token) await uploadCookie()
})

// 账号与云端歌单同步
function renderAccount() {
  const out = $('#acc-out'), inn = $('#acc-in')
  if (state.account?.token) {
    out.hidden = true
    inn.hidden = false
    $('#acc-name').textContent = ' · ' + (state.account.username || '')
  } else {
    out.hidden = false
    inn.hidden = true
  }
}
function loginAccount() {
  const msg = $('#acc-msg')
  msg.textContent = ''
  msg.className = 'hint'
  const username = $('#acc-user').value.trim()
  const password = $('#acc-pass').value
  if (!username || !password) { msg.textContent = '用户名和密码都要填'; return }
  api('/api/auth/login', { method: 'POST', body: { username, password } })
    .then(async (d) => {
      state.account = { token: d.token, username: d.username }
      saveJSON('cm.account', state.account)
      $('#acc-pass').value = ''
      renderAccount()
      toast('登录成功，可同步歌单了')
      await syncCookieFromCloud()
      await loadCloudLists()
      await syncLocalLists()
    })
    .catch((e) => { msg.textContent = e.message })
}
function logoutAccount(silent) {
  state.account = null
  localStorage.removeItem('cm.account')
  $('#acc-out').hidden = false
  $('#acc-in').hidden = true
  renderLoginAccount()
  if (!silent) toast('已退出登录')
}
$('#acc-login').addEventListener('click', loginAccount)
$('#acc-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') loginAccount() })
$('#acc-save').addEventListener('click', () => syncLocalLists(true))
$('#acc-logout').addEventListener('click', () => logoutAccount(false))

// 登录页的账号登录
$('#l-acc-login').addEventListener('click', loginAccountFromLogin)
$('#l-acc-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') loginAccountFromLogin() })
$('#l-skip').addEventListener('click', () => { localStorage.setItem('cm.loggedIn', '1'); showApp() })

// 迷你播放器
$('#mini-text').addEventListener('click', openPlayer)
$('#mini-cover').addEventListener('click', openPlayer)
$('#mini-play').addEventListener('click', () => { if (audio.paused) audio.play().catch(() => {}); else audio.pause() })
$('#mini-next').addEventListener('click', () => step(1))
$('#mini-queue').addEventListener('click', showQueue)
// 左右滑切歌（安卓 MiniPlayerBar）
let swipeX = null
$('#mini').addEventListener('touchstart', (e) => { swipeX = e.touches[0].clientX }, { passive: true })
$('#mini').addEventListener('touchend', (e) => {
  if (swipeX === null) return
  const dx = e.changedTouches[0].clientX - swipeX
  swipeX = null
  if (Math.abs(dx) > 24) step(dx < 0 ? 1 : -1)
}, { passive: true })

// 播放页
$('#pp-close').addEventListener('click', closePlayer)
$('#pp-more').addEventListener('click', openPlayerSheet)
$('#pp-queue').addEventListener('click', showQueue)
$('#pp-fav').addEventListener('click', toggleFav)
$('#pp-play').addEventListener('click', () => { if (audio.paused) audio.play().catch(() => {}); else audio.pause() })
$('#pp-prev').addEventListener('click', () => step(-1))
$('#pp-next').addEventListener('click', () => step(1))
$('#pp-mode').addEventListener('click', () => {
  state.playMode = state.playMode === 'order' ? 'shuffle' : state.playMode === 'shuffle' ? 'repeat1' : 'order'
  localStorage.setItem('cm.playMode', state.playMode)
  $('#pp-mode').innerHTML = modeIcon(state.playMode)
  toast(`播放模式：${MODE[state.playMode].label}`)
})
$('#pp-seek').addEventListener('input', (e) => {
  const d = audio.duration
  if (Number.isFinite(d) && d > 0) audio.currentTime = Number(e.target.value) / 1000 * d
})
$$('.pp-dot').forEach((d) => d.addEventListener('click', () => setView(d.dataset.view)))
// 横向分页：唱片 ↔ 歌词
const pager = $('#pp-pager')
let pagerTimer = null
pager.addEventListener('scroll', () => {
  clearTimeout(pagerTimer)
  pagerTimer = setTimeout(() => {
    const v = pager.scrollLeft > pager.clientWidth / 2 ? 'lyric' : 'cover'
    if (v !== ppView) {
      ppView = v
      $$('.pp-dot').forEach((d) => d.classList.toggle('active', d.dataset.view === v))
      if (v === 'lyric') ensureLyric()
    }
  }, 80)
})
$('#pp-pager .pp-page[data-view="cover"]').addEventListener('click', () => setView('lyric'))
$('#pp-pager .pp-page[data-view="lyric"]').addEventListener('click', (e) => {
  if (!e.target.closest('.pp-lyric-line')) setView('cover')
})
// 左边缘右滑返回（安卓 edgeBackGesture）
let edgeX = null
pager.addEventListener('touchstart', (e) => { edgeX = e.touches[0].clientX < 28 ? e.touches[0].clientX : null }, { passive: true })
pager.addEventListener('touchend', (e) => {
  if (edgeX === null) return
  const dx = e.changedTouches[0].clientX - edgeX
  edgeX = null
  if (dx > 40 && ppView === 'cover') closePlayer()
}, { passive: true })

// 更多菜单（事件委托）
$('#sheet').addEventListener('click', (e) => {
  const maskOrCancel = e.target.closest('[data-close]')
  if (maskOrCancel) { closeSheet(); return }
  const btn = e.target.closest('[data-act]')
  if (!btn) return
  const act = btn.dataset.act
  const t = sheetTrack
  closeSheet()
  switch (act) {
    case 'play': if (t) playFromList([t], 0); break
    case 'favthis': {
      if (!t) break
      const i = state.favs.findIndex((f) => f.key === t.key)
      if (i >= 0) state.favs.splice(i, 1)
      else state.favs.unshift({ ...t })
      saveJSON('cm.favs', state.favs)
      renderLibrary()
      toast(i >= 0 ? '已取消收藏' : '已收藏')
      break
    }
    case 'infothis': showInfo(t); break
    case 'info': showInfo(current()); break
    case 'queue': showQueue(); break
    case 'sleep15': setSleep('time', 15); break
    case 'sleep30': setSleep('time', 30); break
    case 'sleep60': setSleep('time', 60); break
    case 'sleeptrack': setSleep('track'); break
    case 'relyric': lyricKey = ''; lyricLines = []; ensureLyric(); break
    case 'searchlyric': {
      const c = current()
      $('#ls-title').value = c?.title || ''
      $('#ls-artist').value = c?.artist || ''
      $('#modal-lyric').hidden = false
      break
    }
    case 'offset-': adjustOffset(-500); break
    case 'offset+': adjustOffset(500); break
    case 'fav': toggleFav(); break
  }
})
$('#ls-ok').addEventListener('click', runManualLyric)
$$('.modal').forEach((m) => m.addEventListener('click', (e) => {
  if (e.target === m || e.target.closest('[data-close]')) m.hidden = true
}))

// iOS 兜底：若仍被拒，点一下就能播
$('#tap-play').addEventListener('click', () => {
  audio.play().then(() => { $('#tap-to-play').hidden = true }).catch(() => toast('还是没法播放，试着切到另一首歌'))
})

/* ══════════ audio 事件 ══════════ */
audio.addEventListener('play', () => { setPlayIcon(); renderMini() })
audio.addEventListener('pause', () => { setPlayIcon(); })
audio.addEventListener('timeupdate', () => {
  syncTime()
  if (ppOpen) { highlightLyric(); renderSleep() }
  if (state.sleep?.type === 'time' && Date.now() >= state.sleep.endsAt) { stopSleep(); audio.pause() }
})
audio.addEventListener('ended', () => {
  // 静音解锁音（blob/wav）也会触发 ended，忽略非 /api/stream 的源
  if (!/\/api\/stream/.test(audio.currentSrc || '') || !state.resolved) return
  if (state.playMode === 'repeat1') { audio.currentTime = 0; audio.play().catch(() => {}); return }
  if (state.sleep?.type === 'track') { stopSleep(); audio.pause(); return }
  step(1)
})
audio.addEventListener('error', () => {
  if (/\/api\/stream/.test(audio.currentSrc || '')) toast('播放失败：直链可能已失效，去设置里更新夸克 Cookie')
})

/* ══════════ 初始化 ══════════ */
applyTheme()
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
  if ((localStorage.getItem('cm.theme') || 'system') === 'system') applyTheme()
})
$('#set-theme').value = localStorage.getItem('cm.theme') || 'system'
$('#set-online-lyric').checked = state.onlineLyric
if (localStorage.getItem('cm.loggedIn') === '1') showApp()
else showLogin()
renderAccount()
renderQuarkState()
// 已登录则把云端歌单拉回来（换设备也能看到「歌单」列表），并恢复夸克 Cookie
if (state.account?.token) {
  loadCloudLists()
  syncCookieFromCloud()
}

// 开发期不注册 SW，避免反复改页面却看到旧缓存；生产域名才启用 PWA
if ('serviceWorker' in navigator) {
  const dev = /^(127\.0\.0\.1|localhost|0\.0\.0\.0)$/.test(location.hostname)
  if (dev) {
    navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => r.unregister().catch(() => {})))
  } else {
    navigator.serviceWorker.register('/sw.js').catch(() => {})
  }
}
