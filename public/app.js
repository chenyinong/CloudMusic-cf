const $ = (s) => document.querySelector(s)
const audio = $('#audio')

const MODE = {
  order: { icon: '🔁', label: '列表循环' },
  shuffle: { icon: '🔀', label: '随机播放' },
  repeat1: { icon: '🔂', label: '单曲循环' },
}

const state = {
  playlist: loadJSON('cm.playlist'),
  /** 歌单集合：导入的歌单都进这里，顶部「我的歌单」可点开 */
  plists: loadJSON('cm.plists') || [],
  cookie: localStorage.getItem('cm.cookie') || '',
  index: -1,
  busy: false,
  resolved: null,
  favs: loadJSON('cm.favs') || [],
  playMode: localStorage.getItem('cm.playMode') || 'order',
  onlineLyric: localStorage.getItem('cm.onlineLyric') !== 'off',
  lyricOffset: Number(localStorage.getItem('cm.lyricOffset') || 0),
  sleep: null, // { type: 'time'|'track', endsAt? }
  account: loadJSON('cm.account'),
}
let lyricLines = []
let lyricActive = -1
let ppOpen = false
let ppView = 'lyric'

function loadJSON(k) {
  try { return JSON.parse(localStorage.getItem(k) || 'null') } catch { return null }
}
function saveJSON(k, v) { localStorage.setItem(k, JSON.stringify(v)) }
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]))
}
function fmt(sec) {
  const n = Math.max(0, Math.floor(Number(sec) || 0))
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`
}
function setStatus(text, ok = false) {
  const el = $('#status')
  el.textContent = text || ''
  el.classList.toggle('ok', ok)
}
function showNotes(notes) {
  const box = $('#notes-box')
  if (!notes || !notes.length) { box.hidden = true; return }
  box.hidden = false
  $('#notes').textContent = notes.join('\n')
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
/** 带账号令牌的请求，401 时清空登录态 */
async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' }
  if (state.account?.token) headers.Authorization = 'Bearer ' + state.account.token
  const r = await fetch(path, {
    method: opts.method || 'GET',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  if (r.status === 401) { logoutAccountD(true); throw new Error('登录已失效，请重新登录') }
  const d = await r.json().catch(() => ({ error: '返回不是 JSON' }))
  if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`)
  return d
}

// ── 主题 ──────────────────────────────────────────────
function applyTheme() {
  const t = localStorage.getItem('cm.theme') || 'system'
  const sysLight = window.matchMedia('(prefers-color-scheme: light)').matches
  const theme = t === 'system' ? (sysLight ? 'light' : 'dark') : t
  document.documentElement.setAttribute('data-theme', theme)
}

function renderList() {
  const root = $('#tracks')
  const pl = state.playlist
  if (!pl) {
    root.innerHTML = '<div class="empty">导入一张歌单开始</div>'
    $('#playlist-name').textContent = '还没有歌单'
    $('#playlist-meta').textContent = '先从上面导入一张'
    $('#source-badge').textContent = ''
    return
  }
  $('#playlist-name').textContent = pl.name
  $('#playlist-meta').textContent =
    `${pl.platform === 'qq' ? 'QQ 音乐' : '网易云'} · ${pl.tracks.length} 首`
  root.innerHTML = pl.tracks.map((t, i) => `
    <div class="track ${i === state.index ? 'active' : ''}" data-i="${i}">
      <div class="track-cover" data-i="${i}"></div>
      <div>
        <div class="title">${esc(t.title)}</div>
        <div class="sub">${esc(t.artist || '未知歌手')}${t.album ? ' · ' + esc(t.album) : ''}</div>
      </div>
      <div class="dur">${t.durationSec ? fmt(t.durationSec) : '--:--'}</div>
    </div>`).join('')
  root.querySelectorAll('.track').forEach((el) =>
    el.addEventListener('click', () => playAt(Number(el.dataset.i)))
  )
  observeTrackCovers(root, pl.tracks)
}
/** 列表封面：先画安卓同款占位画，进入视口才取真图 */
let trackCoverObserver = null
function observeTrackCovers(root, tracks) {
  if (trackCoverObserver) trackCoverObserver.disconnect()
  const els = root.querySelectorAll('.track-cover')
  els.forEach((el) => {
    const t = tracks[Number(el.dataset.i)]
    if (!t) return
    el.style.backgroundImage = `url("${CoverArt.generated(t.title)}")`
    el.style.backgroundSize = 'cover'
    el.style.backgroundPosition = 'center'
  })
  if (!('IntersectionObserver' in window)) return
  trackCoverObserver = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue
      const el = e.target
      const t = tracks[Number(el.dataset.i)]
      if (t && !el.dataset.loaded) {
        el.dataset.loaded = '1'
        resolveCover(t).then((url) => {
          if (url && el.isConnected) {
            el.style.backgroundImage = `url("${CoverArt.proxied(url)}")`
          }
        })
      }
      trackCoverObserver.unobserve(el)
    }
  }, { rootMargin: '160px' })
  els.forEach((el) => trackCoverObserver.observe(el))
}

function renderPlayer() {
  const t = state.playlist?.tracks?.[state.index]
  const r = state.resolved
  $('#np-title').textContent = t ? t.title : '未在播放'
  const tag = r
    ? `${r.source}${r.partial ? ' · 只有试听片段' : ' · 完整版'}`
    : (t ? '待解析' : '导入歌单后点一首歌')
  $('#np-sub').textContent = t ? `${t.artist || '未知歌手'} · ${tag}` : tag
  $('#source-badge').textContent = r ? r.source : ''
  $('#btn-toggle').textContent = audio.paused ? '▶' : '❚❚'
  if (ppOpen) syncPlayerPage()
}

function parseLrc(text) {
  if (!text) return []
  const out = []
  const tagRe = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g
  for (const line of String(text).split('\n')) {
    tagRe.lastIndex = 0
    const tags = []
    let m
    while ((m = tagRe.exec(line)) !== null) tags.push(m)
    if (!tags.length) continue
    const txt = line.replace(tagRe, '').trim()
    for (const t of tags) {
      const min = Number(t[1])
      const sec = Number(t[2])
      const ms = t[3] ? Number(t[3].padEnd(3, '0')) : 0
      out.push({ time: min * 60 + sec + ms / 1000, text: txt })
    }
  }
  return out.sort((a, b) => a.time - b.time)
}

async function loadLyric(track) {
  const el = $('#pp-lyric-inner')
  lyricLines = []
  lyricActive = -1
  if (!track) { el.innerHTML = ''; return }
  if (!state.onlineLyric) {
    el.innerHTML = '<div class="pp-lyric-none">已关闭在线歌词</div>'
    return
  }
  el.innerHTML = '<div class="pp-lyric-loading">歌词加载中…</div>'
  try {
    const d = await post('/api/lyric', {
      title: track.title,
      artist: track.artist,
      platform: track.platform,
      platformId: track.platformId,
    })
    lyricLines = parseLrc(d.lyric)
    if (!lyricLines.length) {
      el.innerHTML = '<div class="pp-lyric-none">暂无歌词</div>'
    } else {
      el.innerHTML = lyricLines
        .map((l, i) => `<div class="pp-lyric-line" data-i="${i}">${esc(l.text) || '·'}</div>`)
        .join('')
      el.querySelectorAll('.pp-lyric-line').forEach((node) => {
        node.addEventListener('click', () => {
          const t = lyricLines[Number(node.dataset.i)]?.time
          if (Number.isFinite(t)) audio.currentTime = Math.max(0, t - state.lyricOffset / 1000)
        })
      })
    }
  } catch (e) {
    el.innerHTML = '<div class="pp-lyric-none">歌词获取失败</div>'
  }
}

/* 封面：元数据 → 持久化缓存（含 7 天负缓存）→ 同专辑复用 → 后端来源链 */
const coverInflight = new Map()
const COVER_NEG_TTL = 7 * 24 * 3600 * 1000
const COVER_POS_TTL = 30 * 24 * 3600 * 1000
function coverStore() { return loadJSON('cm.covers') || {} }
function coverKey(t) { return `${t?.title || ''}|${t?.artist || ''}` }
function albumKey(t) {
  const a = String(t?.artist || '').trim().toLowerCase()
  const b = String(t?.album || '').trim().toLowerCase()
  return a && b ? `${a}|${b}` : ''
}
function cachedCover(k) {
  const rec = coverStore()[k]
  if (!rec) return undefined
  if (Date.now() - (rec.at || 0) > (rec.url ? COVER_POS_TTL : COVER_NEG_TTL)) return undefined
  return rec.url || null
}
function storeCover(t, url, strict) {
  const s = coverStore()
  s[coverKey(t)] = { url: url || '', at: Date.now() }
  if (url && strict && albumKey(t)) s['@album:' + albumKey(t)] = { url, at: Date.now() }
  try { saveJSON('cm.covers', s) } catch { /* 容量满忽略 */ }
}
function resolveCover(t) {
  const k = coverKey(t)
  if (coverInflight.has(k)) return coverInflight.get(k)
  const p = (async () => {
    if (t.coverUrl) { storeCover(t, t.coverUrl, true); return t.coverUrl }
    const hit = cachedCover(k)
    if (hit !== undefined) return hit
    const ak = albumKey(t)
    const reused = ak ? cachedCover('@album:' + ak) : undefined
    if (reused) { storeCover(t, reused, true); return reused }
    try {
      const d = await post('/api/cover', {
        title: t.title, artist: t.artist, album: t.album, coverUrl: t.coverUrl,
      })
      const url = d.url || null
      storeCover(t, url, !!d.strict)
      return url
    } catch { return null }
  })()
  coverInflight.set(k, p)
  return p
}
async function loadCover(track) {
  const art = $('#pp-art')
  const letter = $('#pp-letter')
  letter.style.display = 'none'
  art.style.backgroundImage = `url("${CoverArt.generated(track?.title || '?')}")`
  art.style.backgroundSize = 'cover'
  art.style.backgroundPosition = 'center'
  if (!track) return
  const url = await resolveCover(track)
  if (url && state.playlist?.tracks?.[state.index] === track) {
    art.style.backgroundImage = `url("${CoverArt.proxied(url)}")`
  }
}

// ── 全屏播放页 ───────────────────────────────────────
function coverHue(str) { return CoverArt.theme(str).h }
function openPlayerPage() {
  if (state.index < 0) return
  ppOpen = true
  $('#player-page').hidden = false
  document.body.style.overflow = 'hidden'
  setView('lyric')
  syncPlayerPage()
}
function closePlayerPage() {
  ppOpen = false
  $('#player-page').hidden = true
  document.body.style.overflow = ''
}
function setView(v) {
  ppView = v
  $('#pp-cover').classList.toggle('active', v === 'cover')
  $('#pp-lyric').classList.toggle('active', v === 'lyric')
  document.querySelectorAll('.pp-dot').forEach((d) =>
    d.classList.toggle('active', d.dataset.view === v)
  )
}
function syncPlayerPage() {
  const t = state.playlist?.tracks?.[state.index]
  const r = state.resolved
  $('#pp-title').textContent = t ? t.title : '未在播放'
  $('#pp-artist').textContent = t ? `${t.artist || '未知歌手'}` : '导入歌单后点一首歌'
  $('#pp-source').textContent = r ? `${r.source}${r.partial ? ' · 试听片段' : ' · 完整版'}` : ''
  const h = coverHue(t ? t.title : 'music')
  $('#pp-bg').style.background =
    `linear-gradient(180deg, hsl(${h} 55% 32% / .35), hsl(${(h + 40) % 360} 55% 22% / .95))`
  // 封面图由 loadCover 负责；这里不能再用 background 简写覆盖它
  $('#pp-letter').style.display = 'none'
  $('#pp-toggle').textContent = audio.paused ? '▶' : '❚❚'
  $('#pp-mode').textContent = MODE[state.playMode].icon
  $('#pp-mode').title = `播放模式：${MODE[state.playMode].label}`
  $('#pp-fav').textContent = isFav(t) ? '♥' : '♡'
  const d = audio.duration
  $('#pp-tcur').textContent = fmt(audio.currentTime)
  $('#pp-ttotal').textContent = Number.isFinite(d) ? fmt(d) : '0:00'
  if (Number.isFinite(d) && d > 0) {
    $('#pp-seek').value = String(Math.round((audio.currentTime / d) * 1000))
  }
  renderSleep()
}
function isFav(t) {
  return !!t && state.favs.some((f) => f.key === t.key)
}

async function importPlaylist() {
  const input = $('#playlist-input').value.trim()
  if (!input) { setStatus('先贴一个歌单链接或 id'); return }
  const btn = $('#btn-import')
  btn.disabled = true
  setStatus('正在拉歌单…')
  try {
    const pl = await post('/api/playlist', {
      input,
      platform: $('#platform').value || undefined,
    })
    state.playlist = pl
    state.index = -1
    state.resolved = null
    loadLyric(null)
    localStorage.setItem('cm.playlist', JSON.stringify(pl))
    audio.pause()
    audio.removeAttribute('src')
    audio.load()
    await addPlaylist(pl)
    renderList()
    renderPlayer()
    setStatus(state.account?.token
      ? `导入成功，共 ${pl.tracks.length} 首，已同步到云端`
      : `导入成功，共 ${pl.tracks.length} 首（登录账号可自动同步云端）`, true)
    showNotes([])
  } catch (e) {
    setStatus(`导入失败：${e.message}`)
    showNotes([])
  } finally {
    btn.disabled = false
  }
}

/* ══════════ 歌单集合（本地 + 云端） ══════════ */
function savePlists() {
  // 已同步的歌单只留元数据，歌曲列表在云端，点开时按需拉取
  saveJSON('cm.plists', state.plists.map((p) => (p.synced
    ? { id: p.id, cloudId: p.cloudId, name: p.name, platform: p.platform, count: p.count, updatedAt: p.updatedAt, synced: true }
    : p)))
}
function renderPlists() {
  const root = $('#plists')
  if (!root) return
  $('#plists-meta').textContent = state.plists.length
    ? `${state.plists.length} 张 · 登录账号后导入会自动同步到云端`
    : '导入的歌单都在这里，点一下即可载入'
  if (!state.plists.length) {
    root.innerHTML = '<div class="empty">还没有歌单</div>'
    return
  }
  root.innerHTML = state.plists.map((p) => `
    <div class="pli" data-id="${esc(p.id)}">
      <div class="pli-cover"></div>
      <div class="pli-main">
        <div class="pli-title">${esc(p.name)}</div>
        <div class="pli-sub">${esc(p.platform === 'qq' ? 'QQ 音乐' : '网易云')} · ${p.count || 0} 首 · ${p.synced ? '云端' : '本机'}</div>
      </div>
      <button class="pli-act" data-act="open" data-id="${esc(p.id)}">载入</button>
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
    if (!state.account?.token) { setStatus('云端歌单需要先登录账号', false); return }
    try {
      const d = await api('/api/playlists/' + p.cloudId)
      p.tracks = JSON.parse(d.tracks)
      p.count = p.tracks.length
    } catch (e) { setStatus('读取云端歌单失败：' + e.message, false); return }
  }
  state.playlist = { name: p.name, platform: p.platform, id: p.id, tracks: p.tracks }
  state.index = -1
  state.resolved = null
  saveJSON('cm.playlist', state.playlist)
  loadLyric(null)
  renderList()
  renderPlayer()
  setStatus(`已载入歌单「${p.name}」，共 ${p.tracks?.length || 0} 首`, true)
}
async function deletePlaylist(id) {
  const p = state.plists.find((x) => x.id === id)
  if (!p) return
  if (!confirm(`删除歌单「${p.name}」？`)) return
  if (p.synced && p.cloudId) {
    if (!state.account?.token) { setStatus('请先登录账号再删除云端歌单', false); return }
    try { await api('/api/playlists/' + p.cloudId, { method: 'DELETE' }) }
    catch (e) { setStatus('删除云端歌单失败：' + e.message, false); return }
  }
  state.plists = state.plists.filter((x) => x.id !== id)
  savePlists()
  renderPlists()
  setStatus('已删除', true)
}
/** 导入的歌单进集合；已登录则同时存到云端 */
async function addPlaylist(pl) {
  let item
  if (state.account?.token) {
    try {
      const d = await api('/api/playlists', { method: 'POST', body: { name: pl.name, platform: pl.platform, tracks: pl.tracks } })
      item = { id: 'c' + d.id, cloudId: d.id, name: pl.name, platform: pl.platform, count: pl.tracks.length, updatedAt: Date.now(), synced: true }
    } catch {
      setStatus('云端保存失败，已存在本机', false)
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
  if (!pending.length) { if (verbose) setStatus('没有需要同步的歌单', true); return }
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
  setStatus(ok ? `已同步 ${ok} 张歌单到云端` : '同步失败，请稍后再试', true)
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
  } catch (e) { setStatus('读取云端歌单失败：' + e.message, false) }
}

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
  renderList()
  renderPlayer()
  setStatus('正在找完整版…')
  showNotes([])
  const t = pl.tracks[i]
  try {
    const d = await post('/api/resolve', {
      title: t.title,
      artist: t.artist,
      durationSec: t.durationSec,
      platformId: t.platformId,
      cookie: state.cookie,
    })
    showNotes(d.notes || [])
    if (!d.ok || !d.resolved) {
      setStatus(d.error || '没找到可播放的音源')
      return
    }
    state.resolved = d.resolved
    loadLyric(t)
    loadCover(t)
    audio.src = d.resolved.url
    await audio.play()
    setStatus(
      d.resolved.partial ? '只有试听片段，建议更新夸克 Cookie' : '正在播放完整版',
      !d.resolved.partial
    )
    updateMediaSession(t)
  } catch (e) {
    setStatus(`解析失败：${e.message}`)
  } finally {
    state.busy = false
    renderList()
    renderPlayer()
  }
}

function step(delta) {
  const n = state.playlist?.tracks?.length ?? 0
  if (!n) return
  let next
  if (state.playMode === 'repeat1') {
    next = (state.index + delta + n) % n
  } else if (state.playMode === 'shuffle') {
    next = state.index
    if (n > 1) while (next === state.index) next = Math.floor(Math.random() * n)
  } else {
    next = (state.index + delta + n) % n
  }
  playAt(next)
}

function updateMediaSession(t) {
  if (!('mediaSession' in navigator) || !('MediaMetadata' in window)) return
  navigator.mediaSession.metadata = new MediaMetadata({
    title: t.title,
    artist: t.artist || '未知歌手',
    album: t.album || '',
    artwork: [{ src: '/icon.svg', sizes: '512x512', type: 'image/svg+xml' }],
  })
  try {
    navigator.mediaSession.setActionHandler('play', () => audio.play())
    navigator.mediaSession.setActionHandler('pause', () => audio.pause())
    navigator.mediaSession.setActionHandler('previoustrack', () => step(-1))
    navigator.mediaSession.setActionHandler('nexttrack', () => step(1))
  } catch { /* 部分浏览器不支持某些 action */ }
}

// ── 搜索点歌 ─────────────────────────────────────────
async function doSearch() {
  const kw = $('#search-input').value.trim()
  if (!kw) return
  const box = $('#search-results')
  box.innerHTML = '<div class="empty">搜索中…</div>'
  try {
    const d = await post('/api/search', { keyword: kw })
    const tracks = d.tracks || []
    if (!tracks.length) { box.innerHTML = '<div class="empty">没搜到结果</div>'; return }
    box.innerHTML = tracks.map((t, i) => `
      <div class="track" data-i="${i}">
        <div class="idx">${i + 1}</div>
        <div>
          <div class="title">${esc(t.title)}</div>
          <div class="sub">${esc(t.artist || '未知歌手')}${t.album ? ' · ' + esc(t.album) : ''}</div>
        </div>
        <div class="dur">${t.durationSec ? fmt(t.durationSec) : '--:--'}</div>
      </div>`).join('')
    box.querySelectorAll('.track').forEach((el) =>
      el.addEventListener('click', () => {
        setPlaylist({
          name: `搜索：${kw}`,
          platform: 'netease',
          id: 'search',
          tracks,
        }, Number(el.dataset.i))
      })
    )
  } catch (e) {
    box.innerHTML = `<div class="empty">搜索失败：${esc(e.message)}</div>`
  }
}

// ── 收藏 ─────────────────────────────────────────────
function toggleFav() {
  const t = state.playlist?.tracks?.[state.index]
  if (!t) return
  const i = state.favs.findIndex((f) => f.key === t.key)
  if (i >= 0) state.favs.splice(i, 1)
  else state.favs.unshift(structuredClone(t))
  saveJSON('cm.favs', state.favs)
  syncPlayerPage()
  renderFavList()
}
function renderFavList() {
  const box = $('#fav-list')
  if (!state.favs.length) { box.innerHTML = '<div class="empty">还没有收藏</div>'; return }
  box.innerHTML = state.favs.map((t, i) => `
    <div class="track" data-i="${i}">
      <div class="idx">${i + 1}</div>
      <div>
        <div class="title">${esc(t.title)}</div>
        <div class="sub">${esc(t.artist || '未知歌手')}</div>
      </div>
    </div>`).join('')
  box.querySelectorAll('.track').forEach((el) =>
    el.addEventListener('click', () => {
      const i = Number(el.dataset.i)
      setPlaylist({
        name: '我的收藏',
        platform: state.favs[i].platform || 'netease',
        id: 'favs',
        tracks: state.favs,
      }, i)
      $('#fav-modal').hidden = true
    })
  )
}

// ── 更多菜单 ─────────────────────────────────────────
function openSheet() { $('#sheet').hidden = false }
function closeSheet() { $('#sheet').hidden = true }
function showInfo() {
  const t = state.playlist?.tracks?.[state.index]
  const r = state.resolved
  if (!t) return
  $('#info-body').innerHTML = `
    <div class="info-row"><span>歌名</span><b>${esc(t.title)}</b></div>
    <div class="info-row"><span>歌手</span><b>${esc(t.artist || '未知歌手')}</b></div>
    <div class="info-row"><span>专辑</span><b>${esc(t.album || '—')}</b></div>
    <div class="info-row"><span>时长</span><b>${t.durationSec ? fmt(t.durationSec) : '—'}</b></div>
    <div class="info-row"><span>来源</span><b>${esc(t.platform || '—')}${t.platformId ? ' · ' + esc(t.platformId) : ''}</b></div>
    <div class="info-row"><span>音源</span><b>${r ? esc(r.source) + (r.partial ? '（试听片段）' : '') : '—'}</b></div>`
  $('#info-modal').hidden = false
}
function showQueue() {
  const pl = state.playlist
  $('#queue-count').textContent = pl?.tracks?.length ?? 0
  const box = $('#queue-list')
  if (!pl || !pl.tracks.length) { box.innerHTML = '<div class="empty">没有播放列表</div>'; return }
  box.innerHTML = pl.tracks.map((t, i) => `
    <div class="track ${i === state.index ? 'active' : ''}" data-i="${i}">
      <div class="idx">${i === state.index ? '♪' : i + 1}</div>
      <div>
        <div class="title">${esc(t.title)}</div>
        <div class="sub">${esc(t.artist || '未知歌手')}</div>
      </div>
    </div>`).join('')
  box.querySelectorAll('.track').forEach((el) =>
    el.addEventListener('click', () => { playAt(Number(el.dataset.i)); $('#queue-modal').hidden = true })
  )
  $('#queue-modal').hidden = false
}
async function manualLyric() {
  const t = state.playlist?.tracks?.[state.index]
  $('#ls-title').value = t?.title || ''
  $('#ls-artist').value = t?.artist || ''
  $('#lyric-search-modal').hidden = false
}
async function runManualLyric() {
  const title = $('#ls-title').value.trim()
  const artist = $('#ls-artist').value.trim()
  if (!title) return
  $('#lyric-search-modal').hidden = true
  const el = $('#pp-lyric-inner')
  el.innerHTML = '<div class="pp-lyric-loading">歌词加载中…</div>'
  try {
    const d = await post('/api/lyric', { title, artist })
    lyricLines = parseLrc(d.lyric)
    if (!lyricLines.length) el.innerHTML = '<div class="pp-lyric-none">暂无歌词</div>'
    else {
      el.innerHTML = lyricLines.map((l, i) =>
        `<div class="pp-lyric-line" data-i="${i}">${esc(l.text) || '·'}</div>`).join('')
      el.querySelectorAll('.pp-lyric-line').forEach((node) => {
        node.addEventListener('click', () => {
          const t = lyricLines[Number(node.dataset.i)]?.time
          if (Number.isFinite(t)) audio.currentTime = Math.max(0, t - state.lyricOffset / 1000)
        })
      })
    }
  } catch { el.innerHTML = '<div class="pp-lyric-none">歌词获取失败</div>' }
}
function adjustOffset(delta) {
  state.lyricOffset += delta
  localStorage.setItem('cm.lyricOffset', String(state.lyricOffset))
  const s = state.lyricOffset >= 0 ? `快进 ${state.lyricOffset / 1000}s` : `快退 ${-state.lyricOffset / 1000}s`
  setStatus(`歌词偏移：${s}（点歌词行仍按原时间跳转）`)
  lyricActive = -1 // 强制重算高亮
}

// ── 定时关闭 ─────────────────────────────────────────
function setSleep(type, minutes) {
  if (state.sleep?.timer) clearInterval(state.sleep.timer)
  if (type === 'track') {
    state.sleep = { type: 'track' }
  } else {
    state.sleep = { type: 'time', endsAt: Date.now() + minutes * 60000 }
  }
  renderSleep()
  setStatus(type === 'track' ? '已设置：播完本曲后停止' : `已设置：${minutes} 分钟后停止播放`)
}
function stopSleep() {
  state.sleep = null
  $('#pp-sleep').textContent = ''
}
function renderSleep() {
  const el = $('#pp-sleep')
  if (!state.sleep) { el.textContent = ''; return }
  if (state.sleep.type === 'track') { el.textContent = '定时关闭：播完本曲后停止'; return }
  const left = Math.max(0, state.sleep.endsAt - Date.now())
  el.textContent = `定时关闭：剩 ${fmt(left / 1000)}`
}

// ── 事件绑定 ─────────────────────────────────────────
$('#btn-import').addEventListener('click', importPlaylist)
$('#playlist-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') importPlaylist()
})
$('#btn-search').addEventListener('click', doSearch)
$('#search-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doSearch()
})
$('#btn-toggle').addEventListener('click', () => {
  if (audio.paused) audio.play().catch(() => {})
  else audio.pause()
})
$('#btn-prev').addEventListener('click', () => step(-1))
$('#btn-next').addEventListener('click', () => step(1))

// 全屏播放页
$('#mini-info').addEventListener('click', openPlayerPage)
$('#pp-close').addEventListener('click', closePlayerPage)
$('#pp-body').addEventListener('click', (e) => {
  if (e.target.closest('.pp-lyric-line')) return
  setView(ppView === 'cover' ? 'lyric' : 'cover')
})
document.querySelectorAll('.pp-dot').forEach((d) =>
  d.addEventListener('click', (e) => { e.stopPropagation(); setView(d.dataset.view) })
)
$('#pp-toggle').addEventListener('click', () => {
  if (audio.paused) audio.play().catch(() => {})
  else audio.pause()
})
$('#pp-prev').addEventListener('click', () => step(-1))
$('#pp-next').addEventListener('click', () => step(1))
$('#pp-mode').addEventListener('click', () => {
  state.playMode = state.playMode === 'order' ? 'shuffle' : state.playMode === 'shuffle' ? 'repeat1' : 'order'
  localStorage.setItem('cm.playMode', state.playMode)
  $('#pp-mode').textContent = MODE[state.playMode].icon
  $('#pp-mode').title = `播放模式：${MODE[state.playMode].label}`
  setStatus(`播放模式：${MODE[state.playMode].label}`)
})
$('#pp-fav').addEventListener('click', toggleFav)
$('#pp-more').addEventListener('click', openSheet)
$('#pp-seek').addEventListener('input', (e) => {
  const d = audio.duration
  if (Number.isFinite(d) && d > 0) audio.currentTime = (Number(e.target.value) / 1000) * d
})

// 更多菜单
document.querySelectorAll('#sheet .sheet-item').forEach((btn) =>
  btn.addEventListener('click', () => {
    const act = btn.dataset.act
    closeSheet()
    switch (act) {
      case 'info': showInfo(); break
      case 'queue': showQueue(); break
      case 'sleep15': setSleep('time', 15); break
      case 'sleep30': setSleep('time', 30); break
      case 'sleep60': setSleep('time', 60); break
      case 'sleeptrack': setSleep('track'); break
      case 'relyric': { const t = state.playlist?.tracks?.[state.index]; if (t) loadLyric(t); break }
      case 'searchlyric': manualLyric(); break
      case 'offset-': adjustOffset(-500); break
      case 'offset+': adjustOffset(500); break
      case 'fav': toggleFav(); break
    }
  })
)
$('#info-close').addEventListener('click', () => { $('#info-modal').hidden = true })
$('#info-modal').addEventListener('click', (e) => { if (e.target.id === 'info-modal') $('#info-modal').hidden = true })
$('#queue-close').addEventListener('click', () => { $('#queue-modal').hidden = true })
$('#queue-modal').addEventListener('click', (e) => { if (e.target.id === 'queue-modal') $('#queue-modal').hidden = true })
$('#ls-cancel').addEventListener('click', () => { $('#lyric-search-modal').hidden = true })
$('#ls-ok').addEventListener('click', runManualLyric)
$('#fav-close').addEventListener('click', () => { $('#fav-modal').hidden = true })
$('#fav-modal').addEventListener('click', (e) => { if (e.target.id === 'fav-modal') $('#fav-modal').hidden = true })
$('#btn-favs').addEventListener('click', () => { renderFavList(); $('#fav-modal').hidden = false })

// 设置
$('#btn-settings').addEventListener('click', () => {
  $('#cookie').value = state.cookie
  $('#theme').value = localStorage.getItem('cm.theme') || 'system'
  $('#online-lyric').checked = state.onlineLyric
  renderAccount()
  $('#settings').hidden = false
})
let loginTimer = null
function closeSettings() {
  $('#settings').hidden = true
  if (loginTimer) { clearInterval(loginTimer); loginTimer = null }
}
$('#btn-cancel').addEventListener('click', closeSettings)
$('#settings').addEventListener('click', (e) => {
  if (e.target.id === 'settings') closeSettings()
})
$('#btn-save').addEventListener('click', async () => {
  saveCookieLocal($('#cookie').value.trim())
  localStorage.setItem('cm.theme', $('#theme').value)
  state.onlineLyric = $('#online-lyric').checked
  localStorage.setItem('cm.onlineLyric', state.onlineLyric ? 'on' : 'off')
  applyTheme()
  closeSettings()
  if (!state.cookie) { setStatus('已清空 Cookie，只用公开源', true); return }
  const synced = await uploadCookie()
  setStatus(synced ? '夸克 Cookie 已保存并同步到云端' : '夸克 Cookie 已保存，会优先找完整版', true)
})
$('#theme').addEventListener('change', () => {
  localStorage.setItem('cm.theme', $('#theme').value)
  applyTheme()
})
$('#online-lyric').addEventListener('change', () => {
  state.onlineLyric = $('#online-lyric').checked
  localStorage.setItem('cm.onlineLyric', state.onlineLyric ? 'on' : 'off')
})

// 夸克 Cookie 云端同步
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
      const box = $('#cookie')
      if (box) box.value = cloud
      setStatus('已从云端恢复夸克 Cookie', true)
    }
  } catch { /* 云端取不到就继续用本机的 */ }
}

// 账号与云端歌单同步
function renderAccount() {
  const out = $('#acc-out'), inn = $('#acc-in')
  if (state.account?.token) {
    out.hidden = true; inn.hidden = false
    $('#acc-name').textContent = state.account.username || ''
  } else { out.hidden = false; inn.hidden = true }
}
async function loginAccountD() {
  const msg = $('#acc-msg'); msg.textContent = ''
  const username = $('#acc-user').value.trim(), password = $('#acc-pass').value
  if (!username || !password) { msg.textContent = '用户名和密码都要填'; return }
  try {
    const d = await api('/api/auth/login', { method: 'POST', body: { username, password } })
    state.account = { token: d.token, username: d.username }
    saveJSON('cm.account', state.account)
    $('#acc-pass').value = ''
    renderAccount()
    setStatus('登录成功', true)
    await syncCookieFromCloud()
    await loadCloudLists()
    await syncLocalLists()
  } catch (e) { msg.textContent = e.message }
}
function logoutAccountD(silent) {
  state.account = null
  localStorage.removeItem('cm.account')
  $('#acc-out').hidden = false
  $('#acc-in').hidden = true
  if (!silent) setStatus('已退出登录', true)
}
$('#acc-login').addEventListener('click', loginAccountD)
$('#acc-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') loginAccountD() })
$('#acc-save').addEventListener('click', () => syncLocalLists(true))
$('#acc-logout').addEventListener('click', () => logoutAccountD(false))

$('#btn-qr-login').addEventListener('click', async () => {
  const btn = $('#btn-qr-login')
  btn.disabled = true
  $('#login-status').textContent = '正在获取登录二维码…'
  if (loginTimer) { clearInterval(loginTimer); loginTimer = null }
  try {
    const d = await post('/api/quark/login/start', {})
    $('#qr-img').src = d.qrImage
    $('#qr-link').href = d.qrText
    $('#qr-box').hidden = false
    $('#login-status').textContent = '等待扫码…'
    let tries = 0
    const startedAt = Date.now()
    loginTimer = setInterval(async () => {
      tries++
      if (tries > 200) {
        clearInterval(loginTimer); loginTimer = null
        $('#login-status').textContent = '二维码可能已失效，请重新点扫码登录'
        return
      }
      try {
        const r = await post('/api/quark/login/poll', { loginToken: d.loginToken })
        if (r.status === 'ok') {
          clearInterval(loginTimer); loginTimer = null
          saveCookieLocal(r.cookie)
          $('#cookie').value = r.cookie
          $('#qr-box').hidden = true
          $('#login-status').textContent = `登录成功${r.account ? '：' + r.account : ''}，Cookie 已保存`
          const synced = await uploadCookie()
          setStatus(synced ? '夸克登录成功，Cookie 已同步到云端' : '夸克登录成功，会优先找完整版', true)
        } else if (r.status === 'expired') {
          clearInterval(loginTimer); loginTimer = null
          $('#login-status').textContent = r.message || '二维码已过期，重新点一次'
          if (r.debug) console.warn('[quark-login]', r.debug)
        } else {
          const secs = Math.floor((Date.now() - startedAt) / 1000)
          $('#login-status').textContent =
            secs > 120
              ? '二维码可能已失效，建议在手机确认后重扫'
              : `等待扫码或手机确认…（${secs}s）`
          if (r.debug) console.log('[quark-login]', r.debug)
        }
      } catch (e) {
        $('#login-status').textContent = `轮询失败：${e.message}`
      }
    }, 3000)
  } catch (e) {
    $('#login-status').textContent = `获取二维码失败：${e.message}`
  } finally {
    btn.disabled = false
  }
})

$('#seek').addEventListener('input', (e) => {
  const d = audio.duration
  if (Number.isFinite(d) && d > 0) audio.currentTime = (Number(e.target.value) / 1000) * d
})
audio.addEventListener('play', renderPlayer)
audio.addEventListener('pause', renderPlayer)
audio.addEventListener('timeupdate', () => {
  const d = audio.duration
  $('#t-cur').textContent = fmt(audio.currentTime)
  $('#t-total').textContent = Number.isFinite(d) ? fmt(d) : '0:00'
  if (Number.isFinite(d) && d > 0) {
    $('#seek').value = String(Math.round((audio.currentTime / d) * 1000))
  }
  if (ppOpen) {
    $('#pp-tcur').textContent = fmt(audio.currentTime)
    $('#pp-ttotal').textContent = Number.isFinite(d) ? fmt(d) : '0:00'
    if (Number.isFinite(d) && d > 0) {
      $('#pp-seek').value = String(Math.round((audio.currentTime / d) * 1000))
    }
    renderSleep()
  }
  // 定时关闭（按时间）
  if (state.sleep?.type === 'time' && Date.now() >= state.sleep.endsAt) {
    stopSleep(); audio.pause()
    return
  }
  // 歌词逐行高亮（含偏移校准）
  if (lyricLines.length) {
    const cur = audio.currentTime + state.lyricOffset / 1000
    let i = lyricActive
    while (i + 1 < lyricLines.length && lyricLines[i + 1].time <= cur) i++
    while (i > 0 && lyricLines[i].time > cur) i--
    if (i !== lyricActive) {
      lyricActive = i
      const lines = $('#pp-lyric-inner').children
      for (const c of lines) c.classList.remove('active')
      const active = lines[i]
      if (active) {
        active.classList.add('active')
        if (ppOpen && ppView === 'lyric') {
          active.scrollIntoView({ block: 'center', behavior: 'smooth' })
        }
      }
    }
  }
})
audio.addEventListener('ended', () => {
  if (state.playMode === 'repeat1') { audio.currentTime = 0; audio.play().catch(() => {}); return }
  if (state.sleep?.type === 'track') { stopSleep(); audio.pause(); return }
  step(1)
})
audio.addEventListener('error', () => {
  if (audio.src) setStatus('播放失败：直链可能已失效，或夸克 Cookie 过期了，去设置里更新')
})

renderList()
renderPlayer()
// 开发期不注册 SW，避免反复改页面却一直看到旧缓存；生产域名才启用 PWA
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then((regs) => {
    for (const r of regs) r.unregister().catch(() => {})
  })
  const dev = /^(127\.0\.0\.1|localhost|0\.0\.0\.0)$/.test(location.hostname)
  if (!dev) navigator.serviceWorker.register('/sw.js').catch(() => {})
}
applyTheme()
renderAccount()
renderPlists()
if (state.account?.token) {
  loadCloudLists()
  syncCookieFromCloud()
}
