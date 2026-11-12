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
  resolved: null,
  /** 正在解析音源（解析期间界面先切歌，源标签显示「正在解析」） */
  resolving: false,
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
      ${opts.source ? `<span class="song-src">${esc(opts.source)}</span>` : ''}
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

/* ══════════ 音源提示 ══════════ */
/** 当前能用到的音源：登录夸克就能拿完整版，否则只有公开源的试听片段 */
function sourceLabel() {
  const r = state.resolved
  if (r && r.source) return { text: `${r.source} · ${r.partial ? '试听片段' : '完整版'}`, partial: !!r.partial }
  if (state.resolving) return { text: '正在解析音源…', partial: false }
  if (state.cookie) return { text: '夸克 · 完整版', partial: false }
  return { text: '公开源 · 试听片段', partial: true }
}
/** 刷新播放页的源标签（小红心下方） */
function renderSourceInfo() {
  const el = $('#pp-source')
  if (!el) return
  const s = sourceLabel()
  el.textContent = s.text
  el.classList.toggle('partial', s.partial)
}

/* ══════════ 歌单集合（本地 + 云端） ══════════ */
function savePlists() {
  // 已同步的歌单只留元数据，歌曲列表在云端，点开时按需拉取
  saveJSON('cm.plists', state.plists.map((p) => (p.synced
    ? { id: p.id, cloudId: p.cloudId, name: p.name, platform: p.platform, count: p.count, updatedAt: p.updatedAt, synced: true, cover: p.cover || '' }
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
      <button class="pli-act danger" data-act="del" data-id="${esc(p.id)}">删除</button>
    </div>`).join('')
  root.querySelectorAll('.pli-cover').forEach((el) => {
    const p = state.plists.find((x) => x.id === el.parentElement.dataset.id)
    // 歌单封面用第一首歌的封面，取不到就退回安卓同款占位画
    if (p) CoverArt.applyCover(el, p.cover || CoverArt.firstCover(p.tracks), p.name)
  })
  // 整行点击即打开歌单，这里只留「删除」
  root.querySelectorAll('[data-act="del"]').forEach((b) =>
    b.addEventListener('click', (e) => {
      e.stopPropagation()
      deletePlaylist(b.dataset.id)
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
    } catch (e) {
      // 云端已经没了（别的设备删的）→ 把本机这张幽灵卡片也清掉
      if (String(e.message || '').includes('找不到')) {
        state.plists = state.plists.filter((x) => x.id !== id)
        savePlists()
        renderPlists()
        toast('这张云端歌单已被删除')
        return
      }
      toast('读取云端歌单失败：' + e.message); return
    }
  }
  state.detail = p
  renderDetail()
  navEnter('detail')   // 压一层，返回手势回到「歌单」列表
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
  // 带 tracks 的是**本机导入的原件**（没登录时导入的，或者云端存失败的）。
  // 云端那份删了就删了，本机这份留着 —— 副本和原件得分清。
  if (p.tracks?.length) {
    p.synced = false
    p.cloudId = null
    p.id = 'l' + Date.now()
    savePlists()
    renderPlists()
    toast('云端那份已删除，本机歌单保留')
    return
  }
  state.plists = state.plists.filter((x) => x.id !== id)
  savePlists()
  renderPlists()
  toast('已删除')
}
/** 导入的歌单进集合；已登录则同时存到云端 */
async function addPlaylist(pl) {
  let item
  const cover = CoverArt.firstCover(pl.tracks)   // 歌单封面 = 第一首歌的封面
  if (state.account?.token) {
    try {
      const d = await api('/api/playlists', { method: 'POST', body: { name: pl.name, platform: pl.platform, tracks: pl.tracks } })
      item = { id: 'c' + d.id, cloudId: d.id, name: pl.name, platform: pl.platform, count: pl.tracks.length, updatedAt: Date.now(), synced: true, cover }
    } catch {
      toast('云端保存失败，已存在本机')
      item = { id: 'l' + Date.now(), name: pl.name, platform: pl.platform, count: pl.tracks.length, updatedAt: Date.now(), synced: false, tracks: pl.tracks, cover }
    }
  } else {
    item = { id: 'l' + Date.now(), name: pl.name, platform: pl.platform, count: pl.tracks.length, updatedAt: Date.now(), synced: false, tracks: pl.tracks, cover }
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
    const cloudIds = new Set()
    for (const p of list) {
      cloudIds.add(p.id)
      const cid = 'c' + p.id
      let exist = state.plists.find((x) => x.cloudId === p.id)
      if (!exist) exist = state.plists.find((x) => !x.synced && x.name === p.name && x.platform === p.platform)
      if (exist) {
        exist.cloudId = p.id
        exist.id = cid
        exist.synced = true
        exist.count = p.count ?? exist.count
        exist.updatedAt = p.updated_at || exist.updatedAt
        exist.cover = p.cover || exist.cover || CoverArt.firstCover(exist.tracks)
        delete exist.tracks
      } else {
        state.plists.unshift({
          id: cid, cloudId: p.id, name: p.name, platform: p.platform,
          count: p.count || 0, updatedAt: p.updated_at || Date.now(), synced: true,
          cover: p.cover || '',
        })
      }
    }
    // 云端已经删掉的（别的设备删的），本机也别留着那张幽灵卡片。
    // 只清「已同步」的 —— 本机还没上传的歌单跟云端没关系，不能动。
    const before = state.plists.length
    state.plists = state.plists.filter((x) => !x.synced || x.cloudId == null || cloudIds.has(x.cloudId))
    if (state.plists.length !== before) toast('云端有歌单被删掉了，已同步移除')
    savePlists()
    renderPlists()
  } catch (e) { toast('读取云端歌单失败：' + e.message) }
}

function renderMini() {
  const t = current()
  const mini = $('#mini')
  mini.hidden = !t
  if (!t) return
  const txt = `${t.title}${t.artist ? ' - ' + t.artist : ''}`
  const box = $('#mini-text')
  const mq = box?.querySelector('.mq')
  if (mq) mq.querySelectorAll('span').forEach((s) => { s.textContent = txt })
  else box.textContent = txt
  syncMiniMarquee()
  const cover = $('#mini-cover')
  fillCover(cover, t)
  cover.classList.toggle('spin', !audio.paused)
  cover.classList.toggle('paused', audio.paused)
  $('#mini-play').innerHTML = `<svg><use href="#${audio.paused ? 'i-play' : 'i-pause'}"/></svg>`
}
/** 迷你播放器里的歌名-歌手太长时改成走马灯（两份一样的文字首尾相接，循环无缝） */
function syncMiniMarquee() {
  const box = $('#mini-text')
  const mq = box?.querySelector('.mq')
  if (!box || !mq) return
  const one = mq.querySelector('span')
  box.classList.remove('scroll')
  if (one && one.scrollWidth > box.clientWidth + 2) box.classList.add('scroll')
}
function setPlayIcon() {
  $('#mini-play').innerHTML = `<svg><use href="#${audio.paused ? 'i-play' : 'i-pause'}"/></svg>`
  $('#pp-play').innerHTML = `<svg><use href="#${audio.paused ? 'i-play' : 'i-pause'}"/></svg>`
  const c = $('#mini-cover')
  c.classList.toggle('spin', !audio.paused)
  c.classList.toggle('paused', audio.paused)
}

/* ══════════ 音源解析缓存 + 预取 ══════════
 * 点一首歌要等 /api/resolve 跑完（要搜源、探活、签发直链令牌），
 * 切歌时干等体感最明显。三招提速：
 *   1) 解析结果缓存到本机 —— 同一首再点直接播，不等网络
 *   2) 当前歌开始播就预取相邻两首 —— 点下一首零等待
 *   3) 连点时只认最后一次 —— 不再因为上一首还在解析就把新点击丢掉
 */
const RESOLVED_KEY = 'cm.resolved'
const RESOLVED_MAX = 80
const resolvedMemo = new Map()        // 会话内快速命中
function resolvedKey(t) { return t?.key || (t?.title ? `${t.title}|${t.artist || ''}` : '') }
function resolvedGet(t) {
  const k = resolvedKey(t)
  if (!k) return null
  const m = resolvedMemo.get(k)
  if (m) return m
  try {
    const all = loadJSON(RESOLVED_KEY) || {}
    const one = all[k]
    if (!one || !one.url) return null
    if (one.exp && one.exp < Date.now()) { delete all[k]; saveJSON(RESOLVED_KEY, all); return null }
    resolvedMemo.set(k, one)
    return one
  } catch { return null }
}
function resolvedPut(t, r) {
  const k = resolvedKey(t)
  if (!k || !r?.url) return
  const one = {
    url: r.url, source: r.source, partial: !!r.partial,
    durationSec: r.durationSec, fileName: r.fileName,
    exp: Date.now() + 80 * 60 * 1000,   // 服务端直链有效期 2 小时，这里留余量
  }
  resolvedMemo.set(k, one)
  try {
    const all = loadJSON(RESOLVED_KEY) || {}
    all[k] = one
    const ks = Object.keys(all)
    if (ks.length > RESOLVED_MAX) for (const old of ks.slice(0, ks.length - RESOLVED_MAX)) delete all[old]
    saveJSON(RESOLVED_KEY, all)
  } catch { /* 配额满了就算了 */ }
}
function resolvedDrop(t) {
  const k = resolvedKey(t)
  if (!k) return
  resolvedMemo.delete(k)
  try {
    const all = loadJSON(RESOLVED_KEY) || {}
    delete all[k]
    saveJSON(RESOLVED_KEY, all)
  } catch { /* 忽略 */ }
}

/* ══════════ 播放 ══════════ */
function setPlaylist(pl, idx) {
  state.playlist = pl
  saveJSON('cm.playlist', pl)
  playAt(idx)
}
let playToken = 0            // 连点时只认最后一次
const prefetching = new Set()  // 正在预取的歌（防止同一首重复预取）
async function playAt(i, attempt = 0) {
  const pl = state.playlist
  if (!pl || !pl.tracks[i]) return
  const t = pl.tracks[i]
  const token = ++playToken
  state.index = i
  state.resolved = null
  state.resolving = true
  // 界面立刻切到新歌（标题/封面/歌词同时开始加载），别让用户盯着上一首干等解析
  onTrackChanged(t)
  renderLibrary()
  renderMini()
  try {
    // 有缓存：不等网络，直接起播（重试时跳过缓存，强制重新解析）
    const cached = attempt ? null : resolvedGet(t)
    if (cached) {
      startResolved(i, t, cached, true, attempt)
    } else {
      toast('正在找完整版…')
      const d = await post('/api/resolve', {
        title: t.title, artist: t.artist, durationSec: t.durationSec,
        platformId: t.platformId, cookie: state.cookie, quarkId: t.quarkId,
        // attempt 1 = 重新签发夸克；attempt 2 = 夸克反复不行，退回公开源
        fresh: attempt > 0, skipQuark: attempt >= 2,
      })
      if (token !== playToken) return          // 已经点了别的歌，这次结果作废
      if (!d.ok || !d.resolved) { toast(d.error || '没找到可播放的音源'); return }
      resolvedPut(t, d.resolved)
      startResolved(i, t, d.resolved, false, attempt)
    }
  } catch (e) {
    if (token !== playToken) return
    toast('解析失败：' + e.message)
  } finally {
    if (token === playToken) {
      state.resolving = false
      renderLibrary()
      renderMini()
      renderSourceInfo()
      prefetchNeighbors()
    }
  }
}
/** 拿到音源后起播 */
function startResolved(i, t, resolved, fromCache, attempt) {
  state.resolved = resolved
  const myToken = playToken
  audio.src = resolved.url
  audio.play().catch((e) => {
    const name = String(e?.name || '')
    const msg = String(e?.message || '')
    // 切歌时旧音频的 play() 会被新 src 打断，抛的是 AbortError —— 这不是错误，直接忽略
    if (/Abort/i.test(name + msg)) return
    // 已经切到别的歌了，这次的失败不用管
    if (myToken !== playToken) return
    if (/NotAllowed/i.test(name + msg)) { $('#tap-to-play').hidden = false; return }
    if (fromCache) {
      // 缓存的直链可能已经失效：清掉重新解析一次
      resolvedDrop(t)
      toast('直链失效，正在重新解析…')
      setTimeout(() => playAt(i), 60)
      return
    }
    if (attempt < 2) {
      // 刚解析出来的直链也可能已经失效（夸克换了令牌、CDN 抽风等）：
      // 先重新签一次夸克，还不行就退回公开源
      resolvedDrop(t)
      toast(attempt === 0 ? '直链失效，正在重新解析…' : '夸克直链还是不行，换公开源…')
      setTimeout(() => playAt(i, attempt + 1), 60)
      return
    }
    toast('播放失败：' + (e.message || '直链可能已失效'))
  })
  if (!fromCache) toast(resolved.partial ? '只有试听片段，建议登录夸克' : '正在播放完整版')
  updateMediaSession(t)
  renderSourceInfo()
}
/**
 * 提前把上一首/下一首解析好，用户点「下一首」或返回上一首时不用等。
 * 只预取相邻两首，既够用又不会把服务器打爆。
 */
function prefetchNeighbors() {
  prefetchOne(nextIndex(1))
  prefetchOne(nextIndex(-1))
}
/** 预取一首歌的音源（已经在缓存里 / 已在预取就跳过） */
async function prefetchOne(i) {
  const pl = state.playlist
  if (i < 0 || !pl?.tracks?.[i]) return
  const t = pl.tracks[i]
  const k = resolvedKey(t)
  if (!k || resolvedGet(t) || prefetching.has(k)) return
  prefetching.add(k)
  try {
    const d = await post('/api/resolve', {
      title: t.title, artist: t.artist, durationSec: t.durationSec,
      platformId: t.platformId, cookie: state.cookie, quarkId: t.quarkId,
    })
    if (d.ok && d.resolved) resolvedPut(t, d.resolved)
  } catch { /* 预取失败无所谓，真播的时候再解析 */ }
  prefetching.delete(k)
}
function onTrackChanged(t) {
  lyricLines = []
  lyricActive = -1
  lyricKey = ''
  $('#pp-lyric-inner').innerHTML = ''
  syncPlayer()
  if (ppView === 'lyric') ensureLyric()
}
/** 下一首的下标（按播放模式）；切歌和预取共用 */
function nextIndex(delta) {
  const n = state.playlist?.tracks?.length ?? 0
  if (!n) return -1
  if (state.playMode === 'repeat1') return (state.index + delta + n) % n
  if (state.playMode === 'shuffle') {
    let next = state.index
    if (n > 1) while (next === state.index) next = Math.floor(Math.random() * n)
    return next
  }
  return (state.index + delta + n) % n
}
function step(delta) {
  const next = nextIndex(delta)
  if (next < 0) return
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
function parseLrc(text, durationSec) {
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
  if (out.length) return out.sort((a, b) => a.time - b.time)
  // 没有时间轴的纯文本歌词 → 按歌曲时长把每行均分成时间轴，照样能跟着歌滚
  return plainLrcToTimed(text, durationSec)
}
/** 纯文本歌词 → 估算时间轴。 */
function plainLrcToTimed(text, durationSec) {
  const META = /^(词|曲|编曲|制作人|混音|监制|出品|发行|录音|母带|和声|吉他|贝斯|鼓|弦乐|出品公司|发行公司)\s*[:：]/
  const body = String(text).split('\n')
    .map((s) => s.replace(/\[[a-z]+:.*?\]/gi, '').trim())
    .filter((s) => s && !META.test(s))
  if (!body.length) return []
  const total = durationSec > 0 ? durationSec : body.length * 4
  const step = total / body.length
  return body.map((t, i) => ({ time: i * step, text: t }))
}
/* 歌词缓存：本机存一份，切回来不用再问服务器 */
const LYRIC_CACHE_MAX = 300
function lyricCacheKey(t) { return 'cm.lyric.' + coverKey(t) }
function lyricCacheGet(t) {
  try {
    const raw = localStorage.getItem(lyricCacheKey(t))
    if (!raw) return null
    const o = JSON.parse(raw)
    if (!o || !o.lyric) return null
    const lines = parseLrc(o.lyric, t.durationSec)
    return lines.length ? { lines, plain: !!o.plain } : null
  } catch { return null }
}
function lyricCachePut(t, lyric, plain) {
  try {
    const k = lyricCacheKey(t)
    localStorage.setItem(k, JSON.stringify({ lyric, plain: !!plain, at: Date.now() }))
    const idx = loadJSON('cm.lyricKeys') || []
    const next = [k, ...idx.filter((x) => x !== k)].slice(0, LYRIC_CACHE_MAX)
    saveJSON('cm.lyricKeys', next)
    for (const old of idx.slice(LYRIC_CACHE_MAX)) localStorage.removeItem(old)
  } catch { /* 配额满了就算了 */ }
}
function lyricCacheDrop(t) {
  try { localStorage.removeItem(lyricCacheKey(t)) } catch { /* 忽略 */ }
}
/** 纯文本歌词没有时间轴，行距是按歌曲长度估算的，标一下免得用户以为错位 */
function markPlainLyric() {
  const inner = $('#pp-lyric-inner')
  if (!inner || inner.querySelector('.pp-lyric-tip')) return
  const tip = document.createElement('div')
  tip.className = 'pp-lyric-tip'
  tip.textContent = '这份歌词没有时间轴，行距按歌曲长度估算'
  inner.prepend(tip)
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
  // 本机有缓存就直接用
  const cached = lyricCacheGet(t)
  if (cached) {
    lyricLines = cached.lines
    lyricActive = -1
    paintLyric(lyricLines)
    if (cached.plain) markPlainLyric()
    return
  }
  inner.innerHTML = '<div class="pp-lyric-loading">歌词加载中…</div>'
  try {
    const d = await post('/api/lyric', {
      title: t.title, artist: t.artist, platform: t.platform, platformId: t.platformId,
    })
    if (lyricKey !== coverKey(t)) return
    lyricLines = parseLrc(d.lyric, t.durationSec)
    lyricActive = -1
    paintLyric(lyricLines)
    if (d.plain) markPlainLyric()
    if (d.lyric) lyricCachePut(t, d.lyric, d.plain)
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
function openPlayerUI() {
  if (ppOpen) return
  ppOpen = true
  $('#player').hidden = false
  syncPlayer()
  setView('lyric', true) // 安卓：从迷你条进来直接停在歌词页
}
function closePlayerUI() { ppOpen = false; $('#player').hidden = true }
/** 打开播放页：压入一层，返回手势才会退回上一页而不是退出应用 */
function openPlayer() {
  if (!current()) return
  if (ppOpen) return
  navEnter('player')
}
function closePlayer() {
  closePlayerUI()
  if (navStack.includes('player')) navBack()
}
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
  renderSourceInfo()   // 小红心下方的源标签
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
  const added = i < 0
  if (added) { state.favs.unshift({ ...t }); toast('已收藏') }
  else { state.favs.splice(i, 1); toast('已取消收藏') }
  saveJSON('cm.favs', state.favs)
  $('#pp-fav').classList.toggle('on', isFav(t))
  renderLibrary()
  syncFavToCloud(t, added)
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
/*
 * 弹层的菜单框是整块 innerHTML 换掉的，所以标题行必须跟菜单项一起重建。
 *
 * 原来写的是「先给 #sheet-head 设标题，再 box.innerHTML = ... 换掉整个菜单框」——
 * innerHTML 会把 #sheet-head 这个节点本身一起冲掉，于是第一次开完弹层，
 * #sheet-head 就永久没了；之后每次开弹层，$('#sheet-head') 拿到 null，
 * 赋 textContent 直接抛 TypeError，函数中断在 $('#sheet').hidden = false 之前，
 * 菜单就再也打不开（控制台只剩一行报错）。
 */
function openSongSheet(t) {
  if (!t) return
  sheetTrack = t
  const box = $('#sheet .sheet-box')
  box.innerHTML = `
    <div class="sheet-head" id="sheet-head">${esc(t.title)} · ${esc(t.artist || '未知歌手')}</div>
    <button class="sheet-item" data-act="play">播放这首</button>
    <button class="sheet-item" data-act="favthis">${state.favs.some((f) => f.key === t.key) ? '取消收藏' : '收藏这首'}</button>
    <button class="sheet-item" data-act="infothis">歌曲信息</button>
    <button class="sheet-item cancel" data-close>取消</button>`
  $('#sheet').hidden = false
  pushOverlay('sheet')
}
function openPlayerSheet() {
  sheetTrack = null
  const t = current()
  const box = $('#sheet .sheet-box')
  box.innerHTML = `
    <div class="sheet-head" id="sheet-head">${t ? `${esc(t.title)} · ${esc(t.artist || '')}` : '播放'}</div>
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
  pushOverlay('sheet')
}
function hideSheet() { $('#sheet').hidden = true; sheetTrack = null }
function closeSheet() { closeOverlay('sheet') }
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
  pushOverlay('modal-info')
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
      el.addEventListener('click', () => { playAt(Number(el.dataset.i)); closeOverlay('modal-queue') }))
    observeCovers(root, list)
  }
  $('#modal-queue').hidden = false
  pushOverlay('modal-queue')
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
  closeOverlay('modal-lyric')
  const inner = $('#pp-lyric-inner')
  inner.innerHTML = '<div class="pp-lyric-loading">歌词加载中…</div>'
  try {
    const d = await post('/api/lyric', { title, artist })
    lyricLines = parseLrc(d.lyric, current()?.durationSec)
    lyricActive = -1
    lyricKey = coverKey(current())
    paintLyric(lyricLines)
    if (d.plain) markPlainLyric()
    if (d.lyric && current()) lyricCachePut(current(), d.lyric, d.plain)
  } catch { inner.innerHTML = '<div class="pp-lyric-none">歌词获取失败</div>' }
}

/* ══════════ Tab / 页面 ══════════ */
function renderTab(tab) {
  state.tab = tab
  $$('.page').forEach((p) => { p.hidden = p.dataset.page !== tab })
  $$('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab))
  $('#page-title').textContent = PAGE_TITLE[tab]
  $('#bar-settings').hidden = tab === 'settings'
  $('#bar-refresh').hidden = tab !== 'library'
  $('#pages').scrollTop = 0
}
/** 切 Tab：先退出当前层级（详情页 / 播放页 / 弹层），再切 */
function switchTab(tab) {
  state.detail = null
  leaveNav()
  renderTab(tab)
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

/* ══════════ 返回栈：安卓式返回手势 ══════════ */
/**
 * navStack 记录界面层级：'detail' 歌单详情 / 'player' 全屏播放页。
 * 每进一层压一条 history，安卓左边缘右滑（PWA 里的系统返回）就会触发 popstate，
 * 我们在这里退回上一层，而不是让系统直接把 App 关掉。
 * 弹层（更多菜单 / 播放列表 / 歌曲信息 / 手动歌词）也压一条：返回时先关弹层。
 */
let navStack = []
let navLock = 0           // 主动 history.go 回退时，忽略这一次 popstate

const OVERLAY_IDS = ['sheet', 'modal-queue', 'modal-info', 'modal-lyric']
function overlayOpen() {
  return OVERLAY_IDS.some((id) => { const el = document.getElementById(id); return el && !el.hidden })
}
function hideAllOverlays() {
  OVERLAY_IDS.forEach((id) => { const el = document.getElementById(id); if (el) el.hidden = true })
  sheetTrack = null
}
/** 当前 history 条目的层级深度（0 = 初始页） */
function navDepth() { return (history.state || {}).cmDepth || 0 }
/** 打开弹层：压一条 history，返回键先关它 */
function pushOverlay(kind) {
  const cur = history.state || {}
  const depth = cur.cmDepth || 0
  const st = { cmNav: navStack, cmDepth: cur.cmOverlay ? depth : depth + 1, cmOverlay: kind }
  if (cur.cmOverlay) history.replaceState(st, '')   // 弹层换弹层：改写当前条目
  else history.pushState(st, '')
}
/** 关闭弹层（用户主动取消 / 确定）：合并回页面层级 */
function closeOverlay(id) {
  const el = document.getElementById(id)
  if (el) el.hidden = true
  if ((history.state || {}).cmOverlay) history.back()
}
/** 进入下一层（歌单详情 / 全屏播放页） */
function navEnter(name) {
  navStack = navStack.concat(name)
  history.pushState({ cmNav: navStack, cmDepth: navDepth() + 1 }, '')
  applyNav()
}
/** 返回上一层：统一交给 popstate 处理 */
function navBack() { history.back() }
/** 彻底退出层级（切 Tab 时用）：把 history 指针退回初始页 */
function leaveNav() {
  hideAllOverlays()
  const d = navDepth()
  if (!d) return
  navStack = []
  navLock = 1
  history.go(-d)
}
/** 按当前 history 状态重绘界面 */
function applyNav(st) {
  const s = st || history.state || {}
  const nav = s.cmNav || []
  if (!s.cmOverlay) hideAllOverlays()
  if (nav.includes('player')) {
    if (nav.includes('detail')) showDetailPage()
    openPlayerUI()
  } else {
    closePlayerUI()
    if (nav.includes('detail')) showDetailPage()
    else {
      state.detail = null
      renderTab(state.tab)
    }
  }
}
window.addEventListener('popstate', (e) => {
  if (navLock > 0) { navLock--; if (!navLock) applyNav(); return }
  navStack = (e.state && e.state.cmNav) || []
  applyNav(e.state)
})
// 初始页：把当前 history 条目标成根层级
history.replaceState({ cmNav: [], cmDepth: 0 }, '')
// 调试用：设置页「复制安装诊断信息」里也会用到
window.__nav = () => ({ stack: navStack, depth: navDepth(), state: history.state })

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
  renderSourceInfo()
}
/* ══════════ 夸克 Cookie 云端同步 ══════════ */
/**
 * 保存本机 Cookie。
 * cm.cookieAt 存「云端时间戳」：0 表示这份 Cookie 还没同步过（时间未知）。
 * 不用手机本地时间做比较——手机时钟不准时会把云端旧值当新的，导致刚扫的码被覆盖。
 */
function saveCookieLocal(cookie) {
  state.cookie = cookie || ''
  localStorage.setItem('cm.cookie', state.cookie)
  localStorage.setItem('cm.cookieAt', '0')
}
/** 把本机 Cookie 上传云端（覆盖旧的）；成功后用服务端时间戳做新旧比较 */
async function uploadCookie() {
  if (!state.account?.token || !state.cookie) return false
  try {
    const d = await api('/api/settings/quark', { method: 'POST', body: { cookie: state.cookie } })
    if (d?.updatedAt) localStorage.setItem('cm.cookieAt', String(d.updatedAt))
    return true
  } catch { return false }
}
/** 采用云端 Cookie（并记下云端时间戳） */
function applyCloudCookie(cloud, cloudAt) {
  state.cookie = cloud
  localStorage.setItem('cm.cookie', cloud)
  localStorage.setItem('cm.cookieAt', String(cloudAt || Date.now()))
  renderQuarkState()
  toast('已从云端恢复夸克 Cookie')
}
/** 问服务端这份 Cookie 还能不能用；true = 已失效，判断不出返回 false */
async function cloudCookieDead(cookie) {
  if (!state.account?.token || !cookie) return false
  try {
    const d = await api('/api/settings/quark/check', { method: 'POST', body: { cookie } })
    return d?.valid === false
  } catch { return false }
}
/** 登录后对齐云端 Cookie：本机刚拿到的优先，其余按服务端时间戳比新旧 */
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
    if (!state.cookie) { applyCloudCookie(cloud, cloudAt); return }
    if (state.cookie === cloud) {
      if (!Number(localStorage.getItem('cm.cookieAt') || 0)) await uploadCookie()  // 补一个云端时间戳
      return
    }
    const localAt = Number(localStorage.getItem('cm.cookieAt') || 0)
    if (!localAt || localAt > cloudAt) {
      // 本机这份更新（或时间未知）→ 覆盖云端，别让云端旧值盖掉刚扫到的码
      if (await uploadCookie()) toast('本机夸克 Cookie 已同步到云端')
      return
    }
    if (await cloudCookieDead(cloud)) {
      // 云端这份已经失效（别人换设备登过、或 Cookie 过期）→ 保住本机这份并回写云端
      if (await uploadCookie()) toast('云端夸克 Cookie 已失效，已改用本机')
      return
    }
    applyCloudCookie(cloud, cloudAt)           // 云端更新 → 用云端的
  } catch { /* 云端取不到就继续用本机的 */ }
}

/* ══════════ 收藏云端同步 ══════════ */
/** 收藏/取消收藏后增量同步到云端 */
async function syncFavToCloud(track, added) {
  if (!state.account?.token || !track?.key) return
  try {
    if (added) await api('/api/favorites', { method: 'POST', body: { key: track.key, track } })
    else await api('/api/favorites/' + encodeURIComponent(track.key), { method: 'DELETE' })
  } catch { /* 云端失败不影响本机使用 */ }
}
/** 登录后合并云端收藏：云端独有的补进本机，云端取消过的本机也删掉，本机独有的补传云端 */
async function syncFavsFromCloud() {
  if (!state.account?.token) return
  try {
    const list = await api('/api/favorites')
    if (!Array.isArray(list)) return
    const cloudKeys = new Set()
    let changed = false
    for (const it of list) {
      const k = it?.key
      if (!k) continue
      cloudKeys.add(k)
      const i = state.favs.findIndex((f) => f.key === k)
      if (it.deleted) {
        if (i >= 0) { state.favs.splice(i, 1); changed = true }   // 别的设备取消了收藏
        continue
      }
      const t = it.track
      if (t?.key && i < 0) { state.favs.unshift(t); changed = true }
    }
    for (const f of state.favs) {
      if (f?.key && !cloudKeys.has(f.key)) {
        await api('/api/favorites', { method: 'POST', body: { key: f.key, track: f } })
      }
    }
    if (changed) {
      saveJSON('cm.favs', state.favs)
      renderLibrary()
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
      await syncFavsFromCloud()
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
$('#pl-back').addEventListener('click', () => navBack())
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

/* ══════════ 搜歌：音源分类胶囊 ══════════
 * 对齐安卓 ImportScreen：搜索结果里一行三个胶囊（全部 / 网易云 / 夸克网盘 + 数量），
 * 点一下只过滤列表，不重新请求、不改排序；播放队列也跟着过滤后的列表走。
 */
const SRC_FILTERS = [
  { id: 'all', label: '全部' },
  { id: 'netease', label: '网易云' },
  { id: 'quark', label: '夸克网盘' },
]
let searchHits = []
let searchCounts = { all: 0, netease: 0, quark: 0 }
let searchFilter = 'all'
let searchKeyword = ''

function hitSources(h) { return Array.isArray(h?.sources) ? h.sources : [] }
/** 行尾的小标签：网易云 / 夸克 / 双源 */
function sourceShort(h) {
  const s = hitSources(h)
  if (!s.length) return ''
  if (s.length > 1) return '双源'
  return s[0] === 'quark' ? '夸克' : '网易云'
}
function visibleSearchHits() {
  if (searchFilter === 'netease') return searchHits.filter((h) => hitSources(h).includes('netease'))
  if (searchFilter === 'quark') return searchHits.filter((h) => hitSources(h).includes('quark'))
  return searchHits
}
function renderSearchCapsules() {
  const el = $('#search-capsules')
  if (!el) return
  if (!searchHits.length) { el.hidden = true; return }
  el.hidden = false
  el.innerHTML = SRC_FILTERS.map((f) =>
    `<button class="src-capsule ${searchFilter === f.id ? 'on' : ''}" data-f="${f.id}">${f.label} ${searchCounts[f.id] ?? 0}</button>`
  ).join('')
  el.querySelectorAll('[data-f]').forEach((b) =>
    b.addEventListener('click', () => {
      searchFilter = b.dataset.f
      renderSearchCapsules()
      renderSearchResults()
    })
  )
}
function renderSearchResults() {
  const root = $('#search-results')
  if (!root) return
  const list = visibleSearchHits()
  if (!list.length) {
    const label = (SRC_FILTERS.find((f) => f.id === searchFilter) || {}).label || ''
    root.innerHTML = emptyBox(searchHits.length ? `「${label}」这个源没搜到东西` : '没搜到结果')
    return
  }
  root.innerHTML = list.map((t, i) => songRow(t, i, { active: false, duration: true, source: sourceShort(t) })).join('')
  bindSongRows(root, list, { name: '搜索：' + searchKeyword })
  observeCovers(root, list)
}
// 搜歌
async function doSearch() {
  const kw = $('#search-input').value.trim()
  if (!kw) return
  const root = $('#search-results')
  root.innerHTML = '<div class="empty">搜索中…</div>'
  $('#search-capsules').hidden = true
  try {
    const d = await post('/api/search', { keyword: kw, cookie: state.cookie })
    searchHits = d.hits || d.tracks || []
    searchCounts = d.counts || { all: searchHits.length, netease: 0, quark: 0 }
    searchFilter = 'all'
    searchKeyword = kw
    const notes = $('#search-notes')
    if (notes) {
      notes.textContent = (d.notes || []).join(' · ')
      notes.hidden = !(d.notes || []).length
    }
    renderSearchCapsules()
    renderSearchResults()
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
/**
 * 检测夸克 Cookie 还有效没有。
 *
 * 走服务端 /api/settings/quark/check：它拿这份 Cookie 去问夸克的账号接口，
 * 401/403 就是失效了。Cookie 失效的典型场景是夸克那边改了登录态，
 * 表现是「本来能播的歌突然播不了」，有个按钮能立刻确认就好。
 */
$('#set-check').addEventListener('click', async () => {
  const out = $('#set-check-out')
  const btn = $('#set-check')
  const typed = $('#set-cookie').value.trim()
  const cookie = typed || state.cookie || ''
  out.hidden = false
  if (!cookie) {
    out.textContent = '还没有 Cookie：先扫码登录，或者手动粘贴一份'
    out.className = 'hint warn'
    return
  }
  // 检测要走服务端（要拿账号令牌），没登录就先说清楚，别发个必然 401 的请求
  if (!state.account?.token) {
    out.textContent = '检测要走云端，先登录云端账号再来'
    out.className = 'hint warn'
    return
  }
  btn.disabled = true
  out.textContent = '检测中…'
  out.className = 'hint'
  try {
    const d = await api('/api/settings/quark/check', { method: 'POST', body: { cookie } })
    const v = d?.valid
    const tail = (typed && typed !== state.cookie) ? '（测的是输入框里的内容，点「保存 Cookie」后生效）' : ''
    if (v === true) {
      out.textContent = 'Cookie 有效' + (d.account ? `（账号：${d.account}）` : '') + tail
      out.className = 'hint ok'
    } else if (v === false) {
      out.textContent = 'Cookie 已失效，重新扫码登录夸克吧' + tail
      out.className = 'hint warn'
    } else {
      // 服务端返回 null = 判断不出来（夸克接口异常），别乱改 Cookie
      out.textContent = '判断不出来（夸克接口没给准信），Cookie 保持原样' + tail
      out.className = 'hint warn'
    }
  } catch (e) {
    out.textContent = '检测失败：' + (e.message || '网络错误')
    out.className = 'hint warn'
  } finally {
    btn.disabled = false
  }
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

/* ══════════ 添加到主屏幕（PWA 安装） ══════════
 * Chrome 的安装入口（beforeinstallprompt）坑不少：
 *   1) 事件只能触发一次，用户取消后本页再也不会有第二次；
 *   2) prompt() 用过了 / 没有用户手势，会抛 InvalidStateError / NotAllowedError；
 *   3) 页面还没被 Service Worker 接管时，Chrome 干脆不给这个事件；
 *   4) 刚卸载完 PWA，系统里可能还留着安装记录，Chrome 会压一阵子安装框。
 * 所以这一段的目标是：任何一步失败都能指出「下一步点哪里」，而不是让按钮装死。
 */
const PWA_INSTALLED_KEY = 'cm.pwa.installed'
const PWA_RETRY_KEY = 'cm.pwa.retry'     // sessionStorage：刷新后准备再装一次
let installPrompt = null
let promptReady = false            // 浏览器是否给过「安装」入口（可安装才给）
function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: fullscreen)').matches ||
    navigator.standalone === true
}
/** 系统里到底装没装：问得到就问（getInstalledRelatedApps），问不到就退回本机标记 */
async function detectInstalled() {
  if (isStandalone()) return { installed: true, certain: true }
  if ('getInstalledRelatedApps' in navigator) {
    try {
      const apps = await navigator.getInstalledRelatedApps()
      if (Array.isArray(apps)) {
        const hit = apps.some((a) => !a.url || a.url.startsWith(location.origin))
        return { installed: hit, certain: true }
      }
    } catch { /* 有的 ROM 不支持这个 API，忽略 */ }
  }
  return { installed: !!localStorage.getItem(PWA_INSTALLED_KEY), certain: false }
}
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault()
  installPrompt = e
  promptReady = true
  if (sessionStorage.getItem(PWA_RETRY_KEY)) {
    sessionStorage.removeItem(PWA_RETRY_KEY)
    toast('浏览器已给出安装入口，回到「设置 → 应用」再点一次「添加到主屏幕」')
  }
  renderInstallState()
})
window.addEventListener('appinstalled', () => {
  installPrompt = null
  promptReady = false
  localStorage.setItem(PWA_INSTALLED_KEY, String(Date.now()))
  toast('安装完成！图标在「应用抽屉」里搜「云音乐」，长按可拖到桌面')
  renderInstallState()
})
$('#set-install').addEventListener('click', async () => {
  if (isStandalone()) { toast('已经在主屏幕应用里运行了'); return }
  if (installPrompt) {
    try {
      await installPrompt.prompt()
      const r = await installPrompt.userChoice
      installPrompt = null
      promptReady = false
      if (r?.outcome === 'accepted') toast('正在安装…装好后在「应用抽屉」找「云音乐」')
      else {
        sessionStorage.setItem(PWA_RETRY_KEY, '1')
        toast('已取消。点「重新检测安装状态」刷新页面后再试一次')
      }
      renderInstallState()
    } catch (err) {
      // 事件已经用过（InvalidStateError）或没有用户手势（NotAllowedError）
      installPrompt = null
      promptReady = false
      sessionStorage.setItem(PWA_RETRY_KEY, '1')
      toast('安装框没弹出来（' + (err?.name || '未知错误') + '）。点「重新检测安装状态」刷新后再试')
      renderInstallState()
    }
    return
  }
  // 没有可用的安装事件：先自检，把卡住的原因说出来
  const why = await checkInstallable()
  if (why) { toast(why); renderInstallState(); return }
  sessionStorage.setItem(PWA_RETRY_KEY, '1')
  toast('正在重新检测…刷新页面后再点一次「添加到主屏幕」')
  setTimeout(() => location.reload(), 700)
})
// 已经是 App 形态就隐藏这一行
if (isStandalone()) $('#set-install').hidden = true
$('#set-install-recheck').addEventListener('click', () => {
  sessionStorage.setItem(PWA_RETRY_KEY, '1')
  location.reload()
})
/** 可安装性自检：返回空串 = 各项条件都满足；否则返回卡住的原因 */
async function checkInstallable() {
  if (!window.isSecureContext) return '⚠ 不是 HTTPS，Chrome 不允许安装'
  const link = document.querySelector('link[rel=manifest]')
  if (!link) return '⚠ 页面里缺少 link rel=manifest'
  let mf = null
  try {
    const r = await fetch(link.href, { cache: 'no-store' })
    if (!r.ok) return `⚠ manifest 取不到（HTTP ${r.status}）`
    mf = await r.json()
  } catch (e) { return '⚠ manifest 取不到：' + e.message }
  if (!mf.start_url) return '⚠ manifest 里没有 start_url'
  if (!Array.isArray(mf.icons) || !mf.icons.length) return '⚠ manifest 里没有图标'
  for (const ic of mf.icons.slice(0, 3)) {
    try {
      const r = await fetch(new URL(ic.src, link.href).toString(), { cache: 'no-store' })
      if (!r.ok) return `⚠ 图标 ${ic.src} 取不到（HTTP ${r.status}）`
    } catch (e) { return `⚠ 图标 ${ic.src} 取不到：${e.message}` }
  }
  if (!('serviceWorker' in navigator)) return '⚠ 这个浏览器不支持 Service Worker'
  let reg = null
  try { reg = await navigator.serviceWorker.getRegistration() } catch { /* 忽略 */ }
  if (!reg) return '⚠ Service Worker 没注册上，刷新一次页面'
  if (!reg.active) return '⚠ Service Worker 还没激活，刷新一次页面'
  if (!navigator.serviceWorker.controller) return '⚠ 页面还没被 Service Worker 接管，刷新一次页面'
  return ''
}
/** 安装状态自检：让用户一眼看出是「没部署/没 HTTPS/SW 没就绪」还是「已装好」 */
async function renderInstallState() {
  const el = $('#set-install-state')
  if (!el) return
  const bits = []
  bits.push(isStandalone() ? '已在主屏幕 App 中运行' : '当前在浏览器中运行')
  const det = await detectInstalled()
  if (det.installed) {
    bits.push(det.certain ? '✓ 本机已安装（图标在应用抽屉里）' : '本机装过（应用抽屉里没图标就是已被系统清掉）')
  } else {
    bits.push('尚未安装到主屏幕')
    // 问得出来却没装 → 之前那个「已安装」标记作废（卸载后标记还留着）
    if (det.certain && localStorage.getItem(PWA_INSTALLED_KEY)) localStorage.removeItem(PWA_INSTALLED_KEY)
  }
  if ('serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.getRegistration()
      bits.push(reg?.active ? '离线缓存已就绪' : '离线缓存未就绪，刷新一次即可')
    } catch { bits.push('离线缓存不可用') }
  } else {
    bits.push('浏览器不支持离线缓存')
  }
  if (!window.isSecureContext) bits.push('⚠ 非 HTTPS，无法安装')
  else if (!promptReady && !isStandalone()) {
    bits.push('⚠ 浏览器暂时没给安装框：点「重新检测安装状态」刷新后再试，或用 Chrome 菜单 → 安装应用')
  }
  el.textContent = bits.join(' · ')
}

/** 复制安装诊断信息：用户在手机上点了直接粘贴给我，一次定位问题 */
$('#set-diag').addEventListener('click', async () => {
  const lines = []
  lines.push('URL: ' + location.href)
  lines.push('UA: ' + navigator.userAgent)
  lines.push('isSecureContext: ' + window.isSecureContext)
  lines.push('display-mode: ' + (isStandalone() ? 'standalone' : 'browser'))
  lines.push('manifest: ' + (document.querySelector('link[rel=manifest]')?.href || '无'))
  lines.push('浏览器给出安装入口: ' + promptReady)
  lines.push('本机已安装标记: ' + (localStorage.getItem(PWA_INSTALLED_KEY) || '无'))
  const det = await detectInstalled()
  lines.push('系统已装 WebAPK: ' + det.installed + '（确定=' + det.certain + '）')
  lines.push('可安装性自检: ' + ((await checkInstallable()) || '各项条件正常'))
  try {
    const reg = await navigator.serviceWorker.getRegistration()
    lines.push('SW: ' + (reg ? `scope=${reg.scope} active=${!!reg.active} state=${reg.active && reg.active.state} 已接管=${!!navigator.serviceWorker.controller}` : '未注册'))
  } catch (e) { lines.push('SW: 查询失败 ' + e.message) }
  for (const u of ['/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png', '/sw.js']) {
    try {
      const r = await fetch(u, { cache: 'no-store' })
      lines.push(u + ': ' + r.status + ' ' + (r.headers.get('content-type') || ''))
    } catch (e) { lines.push(u + ': 失败 ' + e.message) }
  }
  const txt = lines.join('\n')
  try {
    await navigator.clipboard.writeText(txt)
    toast('诊断信息已复制，粘贴发给我')
  } catch {
    prompt('复制下面的诊断信息：', txt)
  }
})
renderInstallState()

// 登录页
$('#l-enter').addEventListener('click', async () => {
  const c = $('#l-cookie').value.trim()
  if (c) saveCookieLocal(c)          // 空值不清掉已有 Cookie（清空请到设置页）
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
      await syncFavsFromCloud()
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
/* 左边缘右滑返回（安卓 edge back）：播放页收起，其它层级返回上一级 */
let edgeX = null
let edgeY = null
document.addEventListener('touchstart', (e) => {
  if ($('#app').hidden) return
  if (e.target.closest && e.target.closest('#mini')) return   // 迷你条自己有左右滑切歌
  const t = e.touches[0]
  if (!t) return
  edgeX = t.clientX < 28 ? t.clientX : null
  edgeY = edgeX === null ? null : t.clientY
}, { passive: true })
document.addEventListener('touchend', (e) => {
  if (edgeX === null) return
  const dx = e.changedTouches[0].clientX - edgeX
  const dy = Math.abs(e.changedTouches[0].clientY - (edgeY || 0))
  edgeX = null
  edgeY = null
  if (dx <= 40 || dx < dy * 1.5) return      // 必须是明显的横向滑动
  if (ppOpen) closePlayer()
  else navBack()
}, { passive: true })
// 键盘返回键（外接键盘 Esc）
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') navBack() })

// 更多菜单（事件委托）
$('#sheet').addEventListener('click', (e) => {
  const maskOrCancel = e.target.closest('[data-close]')
  if (maskOrCancel) { closeSheet(); return }
  const btn = e.target.closest('[data-act]')
  if (!btn) return
  const act = btn.dataset.act
  const t = sheetTrack
  // 弹层换弹层时只隐藏 DOM，历史条目交给后面的 pushOverlay 改写（避免多退一格）
  const opensOverlay = act === 'info' || act === 'infothis' || act === 'queue' || act === 'searchlyric'
  if (opensOverlay) hideSheet()
  else closeSheet()
  switch (act) {
    case 'play': if (t) playFromList([t], 0); break
    case 'favthis': {
      if (!t) break
      const i = state.favs.findIndex((f) => f.key === t.key)
      const added = i < 0
      if (added) state.favs.unshift({ ...t })
      else state.favs.splice(i, 1)
      saveJSON('cm.favs', state.favs)
      renderLibrary()
      toast(added ? '已收藏' : '已取消收藏')
      syncFavToCloud(t, added)
      break
    }
    case 'infothis': showInfo(t); break
    case 'info': showInfo(current()); break
    case 'queue': showQueue(); break
    case 'sleep15': setSleep('time', 15); break
    case 'sleep30': setSleep('time', 30); break
    case 'sleep60': setSleep('time', 60); break
    case 'sleeptrack': setSleep('track'); break
    case 'relyric': {
      const c = current()
      if (c) lyricCacheDrop(c)
      lyricKey = ''; lyricLines = []; ensureLyric(); break
    }
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
  if (e.target === m || e.target.closest('[data-close]')) closeOverlay(m.id)
}))

// iOS 兜底：若仍被拒，点一下就能播
$('#tap-play').addEventListener('click', () => {
  audio.play().then(() => { $('#tap-to-play').hidden = true }).catch(() => toast('还是没法播放，试着切到另一首歌'))
})

/* ══════════ audio 事件 ══════════ */
audio.addEventListener('play', () => { setPlayIcon(); renderMini() })
audio.addEventListener('pause', () => { setPlayIcon(); })
// 屏幕旋转 / 窗口变化后重新判断迷你播放器要不要走马灯
window.addEventListener('resize', () => syncMiniMarquee())
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
  syncFavsFromCloud()
}

// 开发期不注册 SW，避免反复改页面却看到旧缓存；生产域名才启用 PWA
if ('serviceWorker' in navigator) {
  const dev = /^(127\.0\.0\.1|localhost|0\.0\.0\.0)$/.test(location.hostname)
  if (dev) {
    navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => r.unregister().catch(() => {})))
  } else {
    // updateViaCache: 'none' —— sw.js 永远不过 HTTP 缓存，
    // 免得浏览器拿旧 SW 去判定「可安装」，装不上还找不到原因
    navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' })
      .then(() => navigator.serviceWorker.ready)
      .then(() => renderInstallState())   // SW 激活后重算一次安装状态
      .catch(() => {})
    // SW 接管页面后 Chrome 才肯给安装入口，接管了再刷新一次状态
    navigator.serviceWorker.addEventListener('controllerchange', () => renderInstallState())
  }
}
