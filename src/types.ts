export interface Env {
  ASSETS: Fetcher
  STREAM_SECRET: string
  QUARK_COOKIE?: string
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
