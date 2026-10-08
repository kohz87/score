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
