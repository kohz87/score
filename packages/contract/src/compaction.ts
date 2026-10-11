import { z } from 'zod'
import { AgentIdSchema } from './types.ts'

/** How long the bridge has to answer a compact command: summarising is a model call (contract §11). */
export const COMPACT_COMMAND_TTL_MS = 180_000
/** Recent exchanges Hermes keeps word for word when the person does not choose (`/compress here N` default). */
export const COMPACT_KEEP_RECENT_DEFAULT = 2

export const CompactRequestSchema = z.object({ keepRecent: z.int().min(1).max(20).optional() }).strict()
export type CompactRequest = z.infer<typeof CompactRequestSchema>

export const CompactAcceptedSchema = z.object({ commandId: z.string().min(1).max(128) })
export type CompactAccepted = z.infer<typeof CompactAcceptedSchema>

/** Hermes's own rough size estimate of a session's request: its message count and tokens. */
export const SessionSizeSchema = z.object({
  messages: z.int().nonnegative(),
  tokens: z.int().nonnegative(),
})
export type SessionSize = z.infer<typeof SessionSizeSchema>

export const CompactFailureReasonSchema = z.enum([
  'bridge_unavailable', // no Score bridge in that agent's running gateway
  'no_answer', // the bridge did not answer in time (the compaction may or may not have happened)
  'session_busy', // Hermes holds its compression lock for the session, or it is being used
  'lock_held',
  'no_session', // Hermes has no readable session for this room and agent
  'compact_failed', // Hermes refused or failed
])
export type CompactFailureReason = z.infer<typeof CompactFailureReasonSchema>

/** Stream event `session.compacted`: the answer to a compact request. */
export const SessionCompactedSchema = z.object({
  commandId: z.string().min(1).max(128),
  agentId: AgentIdSchema,
  sessionId: z.string().min(1).max(256),
  roomId: z.string().min(1).nullable(),
  status: z.enum(['compacted', 'nothing', 'failed']),
  reason: CompactFailureReasonSchema.nullable(),
  keepRecent: z.int().positive().nullable(),
  before: SessionSizeSchema.nullable(),
  after: SessionSizeSchema.nullable(),
})
export type SessionCompacted = z.infer<typeof SessionCompactedSchema>

export const ContextPartKindSchema = z.enum([
  'system_prompt',
  'tool_definitions',
  'rules',
  'skills',
  'mcp',
  'subagent_definitions',
  'memory',
  'conversation',
])
export const ContextPartSchema = z.object({
  kind: ContextPartKindSchema,
  label: z.string().min(1).max(60),
  tokens: z.int().nonnegative(),
})
export type ContextPart = z.infer<typeof ContextPartSchema>
export const ReadingSourceSchema = z.enum([
  'provider_usage',
  'provider_usage_plus_estimate',
  'local_estimate',
])
export type ReadingSource = z.infer<typeof ReadingSourceSchema>

/** The plugin's answer to a `context_breakdown` query (contract §11). */
export const SessionContextReadingSchema = z.object({
  window: z.int().nonnegative(),
  used: z.int().nonnegative(),
  model: z.string().max(200),
  source: ReadingSourceSchema,
  autoCompactAt: z.int().positive().nullable(),
  parts: z.array(ContextPartSchema).max(16),
})
export type SessionContextReading = z.infer<typeof SessionContextReadingSchema>

/** `GET /api/agents/:agentId/sessions/:sessionId/context`: the context meter's data. */
export const SessionContextSchema = z.object({
  window: z.int().positive().nullable(),
  used: z.int().nonnegative().nullable(),
  measuredAt: z.iso.datetime().nullable(),
  model: z.string().nullable(),
  source: ReadingSourceSchema.nullable(),
  /** Null = Hermes's breakdown is not available (the totals are Score's own). */
  parts: z.array(ContextPartSchema).nullable(),
  autoCompactAt: z.int().positive().nullable(),
  /** Compactions of this session Score has seen answered. */
  compactions: z.int().nonnegative(),
})
export type SessionContext = z.infer<typeof SessionContextSchema>

export const RoomDeleteRequestSchema = z.object({ confirm: z.string().min(1).max(200) }).strict()
export type RoomDeleteRequest = z.infer<typeof RoomDeleteRequestSchema>

/** What deleting a room removes, for the confirmation. Nothing is changed. */
export const RoomDeletePlanSchema = z.object({
  name: z.string(),
  messages: z.int().nonnegative(),
  files: z.int().nonnegative(),
  runs: z.int().nonnegative(),
  briefs: z.int().nonnegative(),
  /** Why it can't be deleted now; null when it can. */
  blocked: z.enum(['room_busy', 'orchestration_owned', 'direct']).nullable(),
})
export type RoomDeletePlan = z.infer<typeof RoomDeletePlanSchema>

export const RoomDeletedSchema = z.object({ id: z.string().min(1) })
export type RoomDeleted = z.infer<typeof RoomDeletedSchema>
