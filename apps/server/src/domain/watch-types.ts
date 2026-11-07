import type { WatchFrame } from '@score/contract'
import { z } from 'zod'

export type MarkerKind = 'command' | 'file' | 'browser' | 'asked'
export type Surface = WatchFrame['surface']

export const WatchInfoSchema = z.object({
  output: z.string().optional(),
  tail: z.boolean().optional(),
  exitCode: z.int().nullish(),
  cwd: z.string().nullish(),
  // Only used by the bridge translator, which swaps it for a media id; never stored.
  screenshotPath: z.string().max(4096).optional(),
})
export type WatchInfo = z.infer<typeof WatchInfoSchema>

export interface ToolFrameInput {
  hook: 'pre' | 'post'
  tool: string
  args: unknown
  result: unknown
  /** The bridge's tool status: running (pre), ok, error or blocked. */
  status: 'running' | 'ok' | 'error' | 'blocked'
  watch: WatchInfo | null
  lastBrowser: { url: string; title: string | null } | null
  /** Media id of this call's screenshot (browser_vision only), already stored by the bridge route. */
  screenshotMediaId?: string | null
}
export interface FrameDraft {
  suffix: string
  surface: Surface
  payload: NonNullable<WatchFrame['terminal'] | WatchFrame['editor'] | WatchFrame['browser']>
  caption: string
}

export interface WatchPage {
  frames: WatchFrame[]
  markers: { seq: number; at: string; kind: MarkerKind }[]
}
