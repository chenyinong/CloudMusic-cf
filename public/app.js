const $ = (s) => document.querySelector(s)
const audio = $('#audio')

const MODE = {
  order: { icon: '🔁', label: '列表循环' },
  shuffle: { icon: '🔀', label: '随机播放' },
  repeat1: { icon: '🔂', label: '单曲循环' },
}

const state = {
  playlist: loadJSON('cm.playlist'),
  cookie: localStorage.getItem('cm.cookie') || '',
  index: -1,
  busy: false,
  resolved: null,
  favs: loadJSON('cm.favs') || [],
  playMode: localStorage.getItem('cm.playMode') || 'order',
  onlineLyric: localStorage.getItem('cm.onlineLyric') !== 'off',
  lyricOffset: Number(localStorage.getItem('cm.lyricOffset') || 0),
  sleep: null, // { type: 'time'|'track', endsAt? }
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
      <div class="idx">${i === state.index ? '♪' : i + 1}</div>
      <div>
        <div class="title">${esc(t.title)}</div>
        <div class="sub">${esc(t.artist || '未知歌手')}${t.album ? ' · ' + esc(t.album) : ''}</div>
      </div>
      <div class="dur">${t.durationSec ? fmt(t.durationSec) : '--:--'}</div>
    </div>`).join('')
  root.querySelectorAll('.track').forEach((el) =>
    el.addEventListener('click', () => playAt(Number(el.dataset.i)))
  )
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

async function loadCover(track) {
  const art = $('#pp-art')
  const letter = $('#pp-letter')
  letter.style.display = ''
  art.style.backgroundImage = ''
  if (!track) return
  try {
    const d = await post('/api/cover', { title: track.title, artist: track.artist })
    if (d.url) {
      art.style.backgroundImage = `url("${d.url}")`
      art.style.backgroundSize = 'cover'
      art.style.backgroundPosition = 'center'
      letter.style.display = 'none'
    }
  } catch { /* 封面拿不到就用色块 */ }
}

// ── 全屏播放页 ───────────────────────────────────────
function coverHue(str) {
  let h = 0
  for (const c of String(str || 'music')) h = (h * 31 + c.charCodeAt(0)) % 360
  return h
}
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
  $('#pp-art').style.background =
    `linear-gradient(145deg, hsl(${h} 60% 55%), hsl(${(h + 50) % 360} 60% 40%))`
  $('#pp-letter').textContent = t ? (t.title || '♪').charAt(0) : '♪'
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
    renderList()
    renderPlayer()
    setStatus(`导入成功，共 ${pl.tracks.length} 首`, true)
    showNotes([])
  } catch (e) {
    setStatus(`导入失败：${e.message}`)
    showNotes([])
  } finally {
    btn.disabled = false
  }
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
$('#btn-save').addEventListener('click', () => {
  state.cookie = $('#cookie').value.trim()
  localStorage.setItem('cm.cookie', state.cookie)
  localStorage.setItem('cm.theme', $('#theme').value)
  state.onlineLyric = $('#online-lyric').checked
  localStorage.setItem('cm.onlineLyric', state.onlineLyric ? 'on' : 'off')
  applyTheme()
  closeSettings()
  setStatus(state.cookie ? '夸克 Cookie 已保存，会优先找完整版' : '已清空 Cookie，只用公开源', true)
})
$('#theme').addEventListener('change', () => {
  localStorage.setItem('cm.theme', $('#theme').value)
  applyTheme()
})
$('#online-lyric').addEventListener('change', () => {
  state.onlineLyric = $('#online-lyric').checked
  localStorage.setItem('cm.onlineLyric', state.onlineLyric ? 'on' : 'off')
})

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
          state.cookie = r.cookie
          localStorage.setItem('cm.cookie', r.cookie)
          $('#cookie').value = r.cookie
          $('#qr-box').hidden = true
          $('#login-status').textContent = `登录成功${r.account ? '：' + r.account : ''}，Cookie 已保存`
          setStatus('夸克登录成功，会优先找完整版', true)
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
