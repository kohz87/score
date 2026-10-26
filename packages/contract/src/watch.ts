import { z } from 'zod'
import { AsOfSeqSchema } from './http.ts'
import { AgentSummarySchema, WatchFrameSchema } from './types.ts'

// §4 Watch view
export const WatchMarkerKindSchema = z.enum(['command', 'file', 'browser', 'asked'])
export type WatchMarkerKind = z.infer<typeof WatchMarkerKindSchema>
export const WatchMarkerSchema = z.object({
  seq: z.int().positive(),
  at: z.iso.datetime(),
  kind: WatchMarkerKindSchema,
})
export type WatchMarker = z.infer<typeof WatchMarkerSchema>
export const WatchResponseSchema = z.object({
  asOfSeq: AsOfSeqSchema,
  agent: AgentSummarySchema,
  live: z.boolean(),
  /** The agent's latest Hermes session, for "Open in terminal" (`hermes -p <agent> --resume <session>`). */
  sessionId: z.string().min(1).nullable(),
  frames: z.array(WatchFrameSchema),
  markers: z.array(WatchMarkerSchema),
  /** Recorded intervals where events were lost (truncated replay, dropped spool): the history has holes there. */
  gaps: z.array(
    z.object({ from: z.iso.datetime(), to: z.iso.datetime().nullable(), reason: z.string() }),
  ),
})
export type WatchResponse = z.infer<typeof WatchResponseSchema>
export const WatchOverviewItemSchema = z.object({
  agent: AgentSummarySchema,
  thumbnail: z.string().nullable(),
  status: z.string(),
  /** Whether the agent has an active run right now. */
  live: z.boolean(),
  /** The surface of the agent's last frame, for a miniature when there is no screenshot. */
  surface: z.enum(['terminal', 'editor', 'browser']).nullable(),
})
export type WatchOverviewItem = z.infer<typeof WatchOverviewItemSchema>
export const WatchOverviewSchema = z.object({ items: z.array(WatchOverviewItemSchema) })
export type WatchOverview = z.infer<typeof WatchOverviewSchema>

/**
 * 3.3.0 Bot Screen (decision 135): a read-only view of the agent's Hermes Bot Desktop. `human`: someone has taken over
 * the screen, and Score shows nothing while they work; `sandboxed`: the screen runs inside the terminal sandbox, where
 * Score can't reach it.
 */
export const BotScreenStatusSchema = z.object({
  state: z.enum(['running', 'off', 'sandboxed', 'human', 'unavailable']),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  /** Bumped with each screen update; the frame's ETag. */
  frameSeq: z.number().int().nonnegative().optional(),
  reason: z.string().optional(),
})
export type BotScreenStatus = z.infer<typeof BotScreenStatusSchema>
