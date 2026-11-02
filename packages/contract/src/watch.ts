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
  /**
   * 3.17.0: present while this browser session controls the screen (it took over through Hermes' lease). Every other
   * session sees `state: 'human'` meanwhile.
   */
  control: z
    .object({
      takeoverId: z.string().min(1).max(64),
      since: z.iso.datetime(),
      /** Control goes back to the agent at this time unless input arrives first (5 minutes after the last input). */
      idleExpiresAt: z.iso.datetime(),
      /** The hard limit, whatever the input (30 minutes after the takeover). */
      expiresAt: z.iso.datetime(),
    })
    .optional(),
})
export type BotScreenStatus = z.infer<typeof BotScreenStatusSchema>

// ---- 3.17.0: taking over a bot's desktop (docs/briefs/3.17.0-take-over.md) ----
export const BotTakeoverRequestSchema = z
  .object({ password: z.string().max(512).optional() })
  .strict()
export type BotTakeoverRequest = z.infer<typeof BotTakeoverRequestSchema>
export const BotTakeoverRefSchema = z.object({ takeoverId: z.string().min(1).max(64) }).strict()
export type BotTakeoverRef = z.infer<typeof BotTakeoverRefSchema>
/** One keyboard or pointer event: X11 keysym and press state, or a position in screen pixels and the button mask. */
export const BotInputEventSchema = z.discriminatedUnion('k', [
  z
    .object({ k: z.literal('key'), keysym: z.int().min(0).max(0x1fffffff), down: z.boolean() })
    .strict(),
  z
    .object({
      k: z.literal('pointer'),
      x: z.int().min(0).max(8191),
      y: z.int().min(0).max(8191),
      buttons: z.int().min(0).max(255),
    })
    .strict(),
])
export type BotInputEvent = z.infer<typeof BotInputEventSchema>
export const BotInputSchema = z
  .object({
    takeoverId: z.string().min(1).max(64),
    events: z.array(BotInputEventSchema).min(1).max(200),
  })
  .strict()
export type BotInput = z.infer<typeof BotInputSchema>
