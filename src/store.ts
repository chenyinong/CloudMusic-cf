// D1 存储层：用户与歌单的增删查。
import type { UserRow, PlaylistRow, UserSettingRow, FavoriteRow } from './types'

export async function createUser(
  db: D1Database,
  username: string,
  passwordHash: string
): Promise<number> {
  const r = await db
    .prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)')
    .bind(username, passwordHash, Date.now())
    .run()
  return Number(r.meta.last_row_id)
}

export async function getUserByName(
  db: D1Database,
  username: string
): Promise<UserRow | null> {
  return (await db
    .prepare('SELECT * FROM users WHERE username = ?')
    .bind(username)
    .first()) as UserRow | null
}

export async function getUserById(db: D1Database, id: number): Promise<UserRow | null> {
  return (await db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first()) as UserRow | null
}

export async function listUsers(db: D1Database): Promise<Array<{ id: number; username: string; created_at: number }>> {
  const r = await db
    .prepare('SELECT id, username, created_at FROM users ORDER BY id')
    .all()
  return r.results as Array<{ id: number; username: string; created_at: number }>
}

export async function deleteUser(db: D1Database, id: number): Promise<void> {
  await db.prepare('DELETE FROM playlists WHERE user_id = ?').bind(id).run()
  await db.prepare('DELETE FROM user_settings WHERE user_id = ?').bind(id).run()
  await db.prepare('DELETE FROM favorites WHERE user_id = ?').bind(id).run()
  await db.prepare('DELETE FROM users WHERE id = ?').bind(id).run()
}

/* ── 用户设置（夸克 Cookie） ───────────────────────────────── */

export async function getUserSetting(
  db: D1Database,
  userId: number
): Promise<UserSettingRow | null> {
  return (await db
    .prepare('SELECT * FROM user_settings WHERE user_id = ?')
    .bind(userId)
    .first()) as UserSettingRow | null
}

/** 覆盖式保存：新 Cookie 直接盖掉旧的。 */
export async function saveUserSetting(
  db: D1Database,
  userId: number,
  quarkCookie: string
): Promise<number> {
  const now = Date.now()
  await db
    .prepare(
      'INSERT INTO user_settings (user_id, quark_cookie, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET quark_cookie = excluded.quark_cookie, updated_at = excluded.updated_at'
    )
    .bind(userId, quarkCookie, now)
    .run()
  return now
}

export async function deleteUserSetting(db: D1Database, userId: number): Promise<void> {
  await db.prepare('DELETE FROM user_settings WHERE user_id = ?').bind(userId).run()
}

/* ── 收藏（小红心） ─────────────────────────────────────── */

export async function listFavorites(db: D1Database, userId: number): Promise<FavoriteRow[]> {
  const r = await db
    .prepare('SELECT * FROM favorites WHERE user_id = ? ORDER BY updated_at DESC, id DESC')
    .bind(userId)
    .all()
  return r.results as unknown as FavoriteRow[]
}

/** 收藏一首；已收藏则只更新歌曲信息，重新收藏会把墓碑清掉。 */
export async function addFavorite(
  db: D1Database,
  userId: number,
  key: string,
  trackJson: string
): Promise<void> {
  const now = Date.now()
  await db
    .prepare(
      'INSERT INTO favorites (user_id, "key", track, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, 0) ON CONFLICT(user_id, "key") DO UPDATE SET track = excluded.track, updated_at = excluded.updated_at, deleted = 0'
    )
    .bind(userId, key, trackJson, now, now)
    .run()
}

/** 取消收藏：软删除（留墓碑），这样别的设备不会把旧数据又同步回来。 */
export async function removeFavorite(
  db: D1Database,
  userId: number,
  key: string
): Promise<void> {
  await db
    .prepare('UPDATE favorites SET deleted = 1, updated_at = ? WHERE user_id = ? AND "key" = ?')
    .bind(Date.now(), userId, key)
    .run()
}

export async function savePlaylist(
  db: D1Database,
  userId: number,
  name: string,
  platform: string,
  tracksJson: string
): Promise<number> {
  const r = await db
    .prepare(
      'INSERT INTO playlists (user_id, name, platform, tracks, updated_at) VALUES (?, ?, ?, ?, ?)'
    )
    .bind(userId, name, platform, tracksJson, Date.now())
    .run()
  return Number(r.meta.last_row_id)
}

export async function listPlaylists(
  db: D1Database,
  userId: number
): Promise<Array<{ id: number; name: string; platform: string; updated_at: number; count: number }>> {
  const r = await db
    .prepare(
      "SELECT id, name, platform, updated_at, CASE WHEN json_valid(tracks) THEN json_array_length(tracks) ELSE 0 END AS count FROM playlists WHERE user_id = ? ORDER BY updated_at DESC"
    )
    .bind(userId)
    .all()
  return r.results as Array<{ id: number; name: string; platform: string; updated_at: number; count: number }>
}

export async function getPlaylist(
  db: D1Database,
  id: number,
  userId: number
): Promise<PlaylistRow | null> {
  return (await db
    .prepare('SELECT * FROM playlists WHERE id = ? AND user_id = ?')
    .bind(id, userId)
    .first()) as PlaylistRow | null
}

export async function deletePlaylist(db: D1Database, id: number, userId: number): Promise<void> {
  await db.prepare('DELETE FROM playlists WHERE id = ? AND user_id = ?').bind(id, userId).run()
}
