import { z } from 'zod'
import { SessionContextReadingSchema } from './compaction.ts'
import { AgentIdSchema, MessageSchema } from './types.ts'

/** Edit or delete of the person's own message X: X and everything after it becomes a previous version. */
export const RewindModeSchema = z.enum(['edit', 'delete'])
export type RewindMode = z.infer<typeof RewindModeSchema>

export const RewindRequestSchema = z.object({
  mode: RewindModeSchema,
  /** Hide in Score without rewinding the agents' Hermes sessions (the person chose it after seeing what failed). */
  scoreOnly: z.boolean().optional(),
})
export type RewindRequest = z.infer<typeof RewindRequestSchema>

export const RewoundAgentSchema = z.object({
  agentId: AgentIdSchema,
  turnsUndone: z.int().nonnegative(),
})
export type RewoundAgent = z.infer<typeof RewoundAgentSchema>

export const RewindSkipReasonSchema = z.enum([
  'score_only', // the person chose "Hide in Score only"
  'compressed', // Hermes compressed the session after X; a rewind across that boundary is not attempted
  'bridge_unavailable', // no Score bridge in that agent's running gateway
  'turn_count_mismatch', // Hermes's own history disagrees with Score's count of that agent's turns
  'no_session', // Hermes has no readable session for this room and agent
  'rewind_failed', // Hermes refused or failed
  'no_answer', // the bridge did not answer in time (the rewind may or may not have happened)
])
export type RewindSkipReason = z.infer<typeof RewindSkipReasonSchema>

export const SkippedAgentSchema = z.object({
  agentId: AgentIdSchema,
  reason: RewindSkipReasonSchema,
})
export type SkippedAgent = z.infer<typeof SkippedAgentSchema>

/** A previous version of a room's conversation, anchored at the message that was edited or deleted. */
export const RoomVersionSchema = z.object({
  id: z.string().min(1),
  roomId: z.string().min(1),
  anchorId: z.string().min(1),
  anchorCreatedAt: z.iso.datetime(),
  mode: RewindModeSchema,
  /** The edit's correction once it is posted (null for a delete or while the edit is still being typed). */
  replacedBy: z.string().min(1).nullable(),
  /** 1-based position in the chain of edits ("Version 2 of 2" is `number: 2` with `count: 2`). */
  number: z.int().positive(),
  count: z.int().positive(),
  hiddenCount: z.int().nonnegative(),
  rewound: z.array(RewoundAgentSchema),
  skipped: z.array(SkippedAgentSchema),
  createdAt: z.iso.datetime(),
})
export type RoomVersion = z.infer<typeof RoomVersionSchema>

export const RewindResponseSchema = z.object({
  version: RoomVersionSchema,
  rewound: z.array(RewoundAgentSchema),
  skipped: z.array(SkippedAgentSchema),
})
export type RewindResponse = z.infer<typeof RewindResponseSchema>

/** What a rewind of X would do, for the confirmation. Nothing is changed. */
export const RewindPlanSchema = z.object({
  hiddenCount: z.int().nonnegative(),
  agents: z.array(
    z.object({
      agentId: AgentIdSchema,
      turns: z.int().nonnegative(),
      /** Null when the agent can be rewound (or has nothing to rewind). */
      cannot: RewindSkipReasonSchema.nullable(),
    }),
  ),
  /** Why a rewind can't start now (an agent is answering, paused work); null when it can. */
  blocked: z.string().nullable(),
})
export type RewindPlan = z.infer<typeof RewindPlanSchema>

export const RoomVersionsSchema = z.object({
  asOfSeq: z.int().nonnegative(),
  items: z.array(RoomVersionSchema),
})
export const RoomVersionDetailSchema = z.object({
  version: RoomVersionSchema,
  /** The hidden messages, anchor first, oldest to newest. */
  items: z.array(MessageSchema),
})
export type RoomVersionDetail = z.infer<typeof RoomVersionDetailSchema>

/** How long the bridge has to answer a rewind command; the command expires then (`expiresAt`). */
export const REWIND_COMMAND_TTL_MS = 60_000
/** Extra time a room stays held after a command's expiry, for clock differences between Score and the plugin. */
export const REWIND_HOLD_SKEW_MS = 5_000

/** Server → bridge plugin: rewind one Hermes session by `turns` user turns (contract §11). */
const RewindCommandSchema = z.object({
  commandId: z.string().min(1).max(128),
  kind: z.literal('rewind'),
  sessionId: z.string().min(1).max(256),
  turns: z.int().positive().max(1000),
  /** Epoch seconds of the message being rewound: the plugin rewinds exactly the turns from there (absolute target). */
  since: z.number().positive().optional(),
  /** Epoch seconds after which the plugin must not act (checked immediately before it mutates): `expired`. */
  expiresAt: z.number().positive(),
})
/** Server → bridge plugin: compact (summarise the older turns of) one Hermes session (PLAN 5.36, contract §11). */
const CompactCommandSchema = z.object({
  commandId: z.string().min(1).max(128),
  kind: z.literal('compact'),
  sessionId: z.string().min(1).max(256),
  /** Recent exchanges kept word for word; absent = Hermes's full compression. */
  keepRecent: z.int().min(1).max(20).optional(),
  expiresAt: z.number().positive(),
})
/** Server → bridge plugin: a read-only query for what uses a session's context window (PLAN 5.36). */
const ContextBreakdownCommandSchema = z.object({
  commandId: z.string().min(1).max(128),
  kind: z.literal('context_breakdown'),
  sessionId: z.string().min(1).max(256),
  expiresAt: z.number().positive(),
})
export const BridgeCommandSchema = z.discriminatedUnion('kind', [
  RewindCommandSchema,
  CompactCommandSchema,
  ContextBreakdownCommandSchema,
])
export type BridgeCommand = z.infer<typeof BridgeCommandSchema>
export const BridgeCommandsResponseSchema = z.object({ items: z.array(BridgeCommandSchema) })

const CommandSizeSchema = z.object({
  messages: z.int().nonnegative(),
  tokens: z.int().nonnegative(),
})
export const BridgeCommandResultSchema = z.object({
  outcome: z.enum(['done', 'nothing', 'failed', 'expired']),
  turnsUndone: z.int().nonnegative().optional(),
  rewoundCount: z.int().nonnegative().optional(),
  before: CommandSizeSchema.optional(),
  after: CommandSizeSchema.optional(),
  context: SessionContextReadingSchema.optional(),
  error: z.string().max(200).optional(),
})
export type BridgeCommandResult = z.infer<typeof BridgeCommandResultSchema>
