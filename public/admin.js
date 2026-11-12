'use strict'

const $ = (s) => document.querySelector(s)

function toast(m) {
  const t = $('#toast')
  t.textContent = m
  t.hidden = false
  clearTimeout(toast._t)
  toast._t = setTimeout(() => (t.hidden = true), 1800)
}

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' }
  // 动态取令牌：登录后才有值，不能用页面加载时的快照
  const t = localStorage.getItem('cm.adminToken')
  if (t) headers.Authorization = 'Bearer ' + t
  const r = await fetch(path, { method: opts.method || 'GET', headers, body: opts.body ? JSON.stringify(opts.body) : undefined })
  const d = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`)
  return d
}

async function loadUsers() {
  const list = await api('/api/admin/users')
  const ul = $('#users')
  ul.innerHTML = ''
  if (!list.length) {
    ul.innerHTML = '<li><span class="meta">还没有用户，在上方添加</span></li>'
    return
  }
  for (const u of list) {
    const li = document.createElement('li')
    const when = new Date(u.created_at).toLocaleDateString()
    li.innerHTML = `<span>${esc(u.username)}<span class="meta">${when}</span></span>`
    const del = document.createElement('button')
    del.className = 'del'
    del.textContent = '删除'
    del.onclick = async () => {
      if (!confirm(`删除用户「${u.username}」及其全部歌单？`)) return
      await api(`/api/admin/users/${u.id}`, { method: 'DELETE' })
      toast('已删除')
      loadUsers()
    }
    li.appendChild(del)
    ul.appendChild(li)
  }
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

async function doLogin() {
  const msg = $('#login-msg')
  msg.textContent = ''
  try {
    const d = await api('/api/admin/login', { method: 'POST', body: { password: $('#pw').value } })
    localStorage.setItem('cm.adminToken', d.token)
    $('#login-box').hidden = true
    $('#admin-box').hidden = false
    loadUsers()
  } catch (e) {
    msg.textContent = e.message
    msg.className = 'msg err'
  }
}

// 已登录则直接进入
if (localStorage.getItem('cm.adminToken')) {
  $('#login-box').hidden = true
  $('#admin-box').hidden = false
  loadUsers().catch(() => { localStorage.removeItem('cm.adminToken'); location.reload() })
}

$('#login').onclick = doLogin
$('#pw').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin() })
$('#logout').onclick = () => {
  localStorage.removeItem('cm.adminToken')
  location.reload()
}
$('#add').onclick = async () => {
  const msg = $('#add-msg')
  msg.className = 'msg'
  msg.textContent = ''
  const username = $('#nu').value.trim()
  const password = $('#np').value
  if (!username || !password) { msg.textContent = '用户名和密码都要填'; msg.className = 'msg err'; return }
  try {
    await api('/api/admin/users', { method: 'POST', body: { username, password } })
    $('#nu').value = ''
    $('#np').value = ''
    msg.textContent = `已创建用户 ${username}`
    msg.className = 'msg ok'
    loadUsers()
  } catch (e) {
    msg.textContent = e.message
    msg.className = 'msg err'
  }
}
