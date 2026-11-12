export interface Env {
  ASSETS: Fetcher
  STREAM_SECRET: string
  QUARK_COOKIE?: string
  DB: D1Database
  /** 后台管理员密码，部署时用 wrangler secret put ADMIN_PASSWORD 覆盖；本地默认 admin888 */
  ADMIN_PASSWORD?: string
}

export interface UserRow {
  id: number
  username: string
  password_hash: string
  created_at: number
}

export interface PlaylistRow {
  id: number
  user_id: number
  name: string
  platform: string
  tracks: string
  updated_at: number
}

export interface UserSettingRow {
  user_id: number
  quark_cookie: string
  updated_at: number
}

export type Platform = 'netease' | 'qq'

export interface Track {
  key: string
  title: string
  artist: string
  album: string
  durationSec: number
  platform: Platform
  platformId?: string
  /** 歌单/搜索接口自带的专辑封面，最准，优先于在线检索 */
  coverUrl?: string
}

export interface ImportedPlaylist {
  name: string
  platform: Platform
  id: string
  tracks: Track[]
}

/** 直链代理的令牌内容（AES-GCM 加密后放进 URL，Cookie 不会明文暴露）。 */
export interface StreamPayload {
  u: string
  c?: string
  r: string
  ua: string
  exp: number
}

export interface Resolved {
  url: string
  source: string
  partial: boolean
  durationSec: number
  note: string
  fileName?: string
}

export interface ResolveRequest {
  title: string
  artist: string
  durationSec: number
  platformId?: string
  cookie?: string
}
