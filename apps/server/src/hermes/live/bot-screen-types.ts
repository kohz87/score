import type { Socket } from 'node:net'

export const MAX_SIDE = 4096

export type BotScreenState = 'running' | 'off' | 'sandboxed' | 'human' | 'unavailable'
export interface BotScreenStatus {
  state: BotScreenState
  width?: number
  height?: number
  frameSeq?: number
  reason?: string
  control?: { takeoverId: string; since: string; idleExpiresAt: string; expiresAt: string }
}
export interface BotScreenFrame {
  seq: number
  png: Buffer
}

/** A takeover Score holds: Hermes' lease names `viewerId` at `epoch`, and only `owner` (a browser session) uses it. */
export interface BotControl {
  takeoverId: string
  viewerId: string
  epoch: number
  owner: string
  since: number
  lastInput: number
  expiresAt: number
  /** Keys and buttons this takeover holds down on the screen, released when it ends while the lease is still Score's. */
  held?: { keys: Set<number>; buttons: number; x: number; y: number }
}
export const CONTROL_IDLE_MS = 5 * 60_000

export interface BotScreenOptions {
  /** The profile's Hermes home, or null when Score doesn't know the profile. */
  profileHome: (agentId: string) => string | null
  /** Score's own UID: the socket must belong to it. */
  uid?: number
  connect?: (path: string) => Socket
  clock?: () => number
  /** A takeover ended because Hermes' lease no longer names it (handed back elsewhere, the Hermes app took over). */
  onLost?: (agentId: string, control: BotControl) => void
}
