import { z } from 'zod'
import { RoomProjectEventSchema, RoomProjectSchema } from './conversations.ts'
import { KnowledgeChangedSchema } from './knowledge.ts'
import { BriefSummarySchema } from './briefs.ts'
import { RoomVersionSchema } from './versions.ts'
import {
  AgentIdSchema,
  AgentSummarySchema,
  AttemptSummarySchema,
  ApprovalSchema,
  HandoffSchema,
  LaneBlockSchema,
  LogLineSchema,
  MessagePartSchema,
  MessageSchema,
  RoomSchema,
  RefSchema,
  RunSummarySchema,
  SystemStatusSchema,
  TaskActivitySchema,
  TaskSummarySchema,
  WatchFrameSchema,
} from './types.ts'

export const MessageDeltaSchema = z.object({
  messageId: z.string().min(1),
  roomId: z.string().min(1),
  append: z.string(),
})
export type MessageDelta = z.infer<typeof MessageDeltaSchema>

export const MessageCompletedSchema = z.object({
  messageId: z.string().min(1),
  roomId: z.string().min(1),
  /** The authoritative final parts: completion can add a plan, tools summary or notice no delta carried. */
  parts: z.array(MessagePartSchema).optional(),
})
export type MessageCompleted = z.infer<typeof MessageCompletedSchema>

/** A message removed from Score (Score-side only: Hermes sessions and runs are untouched). */
export const MessageDeletedSchema = z.object({
  roomId: z.string().min(1),
  messageId: z.string().min(1),
})
export type MessageDeleted = z.infer<typeof MessageDeletedSchema>

/** A message changed in place; today only the original of an edit gets its `editedBy`. */
export const MessageUpdatedSchema = z.object({
  roomId: z.string().min(1),
  messageId: z.string().min(1),
  /** Absent when the update does not concern it. */
  editedBy: z.string().min(1).nullable().optional(),
  /** The message's new parts (a summary edited or marked stale, PLAN 7.4a); they replace the cached parts. */
  parts: z.array(MessagePartSchema).optional(),
})
export type MessageUpdated = z.infer<typeof MessageUpdatedSchema>

/** A streaming reply did something other than write text (a tool call, reasoning, an approval): its stall clock restarts. */
export const MessageProgressedSchema = z.object({
  roomId: z.string().min(1),
  messageId: z.string().min(1),
  at: z.iso.datetime(),
})
export type MessageProgressed = z.infer<typeof MessageProgressedSchema>

export const TypingSchema = z.object({
  roomId: z.string().min(1),
  agentId: AgentIdSchema,
  text: z.string().nullable(),
})
export type Typing = z.infer<typeof TypingSchema>

export const TaskActivityDataSchema = z.object({
  taskId: z.string().min(1),
  item: TaskActivitySchema,
})
export type TaskActivityData = z.infer<typeof TaskActivityDataSchema>

export const LaneUpsertedSchema = z.object({
  briefId: z.string().min(1).nullable(),
  agentId: AgentIdSchema,
  block: LaneBlockSchema,
})
export type LaneUpserted = z.infer<typeof LaneUpsertedSchema>

export const HandoffCreatedSchema = z.object({
  briefId: z.string().min(1).nullable(),
  handoff: HandoffSchema,
})
export type HandoffCreated = z.infer<typeof HandoffCreatedSchema>

export const GapRecordedSchema = z.object({
  source: z.string(),
  runId: z.string().min(1).nullable(),
  from: z.iso.datetime(),
  to: z.iso.datetime().nullable(),
  reason: z.string(),
})
export type GapRecorded = z.infer<typeof GapRecordedSchema>

export const MemorySavedSchema = z.object({
  agentIds: z.array(AgentIdSchema),
  text: z.string(),
  source: RefSchema.nullable(),
})
export type MemorySaved = z.infer<typeof MemorySavedSchema>

export const StreamEnvelopeSchema = z.object({
  seq: z.int().positive(),
  ts: z.iso.datetime(),
  type: z.string(),
  data: z.record(z.string(), z.unknown()),
})
export type StreamEnvelope = z.infer<typeof StreamEnvelopeSchema>

export const StreamEventSchema = z.discriminatedUnion('type', [
  StreamEnvelopeSchema.extend({ type: z.literal('system.status'), data: SystemStatusSchema }),
  StreamEnvelopeSchema.extend({ type: z.literal('agent.updated'), data: AgentSummarySchema }),
  StreamEnvelopeSchema.extend({ type: z.literal('room.upserted'), data: RoomSchema }),
  StreamEnvelopeSchema.extend({
    type: z.literal('room-project.upserted'),
    data: RoomProjectSchema,
  }),
  StreamEnvelopeSchema.extend({
    type: z.literal('room-project.deleted'),
    data: RoomProjectEventSchema,
  }),
  StreamEnvelopeSchema.extend({ type: z.literal('message.created'), data: MessageSchema }),
  StreamEnvelopeSchema.extend({ type: z.literal('message.delta'), data: MessageDeltaSchema }),
  StreamEnvelopeSchema.extend({
    type: z.literal('message.completed'),
    data: MessageCompletedSchema,
  }),
  StreamEnvelopeSchema.extend({ type: z.literal('message.deleted'), data: MessageDeletedSchema }),
  StreamEnvelopeSchema.extend({ type: z.literal('message.updated'), data: MessageUpdatedSchema }),
  StreamEnvelopeSchema.extend({
    type: z.literal('message.progressed'),
    data: MessageProgressedSchema,
  }),
  StreamEnvelopeSchema.extend({
    type: z.literal('room.version.created'),
    data: RoomVersionSchema,
  }),
  StreamEnvelopeSchema.extend({
    type: z.literal('knowledge.changed'),
    data: KnowledgeChangedSchema,
  }),
  StreamEnvelopeSchema.extend({ type: z.literal('typing'), data: TypingSchema }),
  StreamEnvelopeSchema.extend({ type: z.literal('approval.requested'), data: ApprovalSchema }),
  StreamEnvelopeSchema.extend({ type: z.literal('approval.updated'), data: ApprovalSchema }),
  StreamEnvelopeSchema.extend({ type: z.literal('task.upserted'), data: TaskSummarySchema }),
  StreamEnvelopeSchema.extend({ type: z.literal('task.activity'), data: TaskActivityDataSchema }),
  StreamEnvelopeSchema.extend({ type: z.literal('lane.upserted'), data: LaneUpsertedSchema }),
  StreamEnvelopeSchema.extend({ type: z.literal('handoff.created'), data: HandoffCreatedSchema }),
  StreamEnvelopeSchema.extend({ type: z.literal('brief.upserted'), data: BriefSummarySchema }),
  StreamEnvelopeSchema.extend({ type: z.literal('run.updated'), data: RunSummarySchema }),
  StreamEnvelopeSchema.extend({ type: z.literal('attempt.updated'), data: AttemptSummarySchema }),
  StreamEnvelopeSchema.extend({ type: z.literal('gap.recorded'), data: GapRecordedSchema }),
  StreamEnvelopeSchema.extend({ type: z.literal('log.line'), data: LogLineSchema }),
  StreamEnvelopeSchema.extend({ type: z.literal('watch.frame'), data: WatchFrameSchema }),
  StreamEnvelopeSchema.extend({ type: z.literal('memory.saved'), data: MemorySavedSchema }),
])
export type StreamEvent = z.infer<typeof StreamEventSchema>

export const StreamHelloSchema = z.object({
  type: z.literal('stream.hello'),
  seq: z.never().optional(),
  data: z.object({
    epoch: z.string().min(1),
    headSeq: z.int().nonnegative(),
    mode: z.enum(['live', 'fake']),
    system: SystemStatusSchema,
  }),
})
export type StreamHello = z.infer<typeof StreamHelloSchema>

export const StreamResetSchema = z.object({
  type: z.literal('stream.reset'),
  seq: z.never().optional(),
  data: z.object({ reason: z.enum(['pruned', 'epoch', 'future_cursor']) }),
})
export type StreamReset = z.infer<typeof StreamResetSchema>

export const StreamControlFrameSchema = z.discriminatedUnion('type', [
  StreamHelloSchema,
  StreamResetSchema,
])
export type StreamControlFrame = z.infer<typeof StreamControlFrameSchema>

export const ParsedStreamFrameSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('event'), event: StreamEventSchema }),
  z.object({ kind: z.literal('control'), frame: StreamControlFrameSchema }),
  z.object({ kind: z.literal('unknown'), type: z.string() }),
])
export type ParsedStreamFrame = z.infer<typeof ParsedStreamFrameSchema>

const frameTypeSchema = z.object({ type: z.string() })
const eventTypes = new Set<string>(StreamEventSchema.options.map((event) => event.shape.type.value))

// Accept decoded JSON or the SSE data string. Invalid known frames still fail validation.
export function parseStreamFrame(json: unknown): ParsedStreamFrame {
  const value: unknown = typeof json === 'string' ? JSON.parse(json) : json
  const { type } = frameTypeSchema.parse(value)
  if (type === 'stream.hello' || type === 'stream.reset') {
    return { kind: 'control', frame: StreamControlFrameSchema.parse(value) }
  }
  if (eventTypes.has(type)) {
    return { kind: 'event', event: StreamEventSchema.parse(value) }
  }
  return { kind: 'unknown', type }
}
