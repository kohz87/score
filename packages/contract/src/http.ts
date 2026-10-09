import { z } from 'zod'
import {
  AgentIdSchema,
  AgentSummarySchema,
  ApprovalSchema,
  HandoffSchema,
  LaneBlockSchema,
  MessageSchema,
  RefSchema,
  RoomSchema,
  RoutineSummarySchema,
  TaskColumnSchema,
  TaskSummarySchema,
} from './types.ts'

/** The event-log position a snapshot was read at; 0 on a fresh server with no events yet. */
export const AsOfSeqSchema = z.int().nonnegative()

/** Every non-2xx JSON response: `{ error: { code, message, details? } }`. */
export const ErrorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string(),
    details: z.unknown().optional(),
  }),
})
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>

// §5 Chat
export const RoomsSnapshotSchema = z.object({
  asOfSeq: AsOfSeqSchema,
  rooms: z.array(RoomSchema),
  directs: z.array(RoomSchema),
})
export const RoomDetailSnapshotSchema = z.object({
  asOfSeq: AsOfSeqSchema,
  room: RoomSchema,
  filesInPlay: z.array(z.string()),
  learned: z.array(
    z.object({ text: z.string(), savedTo: z.array(z.string()), at: z.iso.datetime() }),
  ),
})
export const MessagePageSchema = z.object({
  asOfSeq: AsOfSeqSchema,
  items: z.array(MessageSchema),
  nextCursor: z.string().nullable(),
})

// §6 Approvals
export const ApprovalsPageSchema = z.object({
  asOfSeq: AsOfSeqSchema,
  items: z.array(ApprovalSchema),
  nextCursor: z.string().nullable(),
})

// §7 Tasks
export const TasksSnapshotSchema = z.object({
  asOfSeq: AsOfSeqSchema,
  columns: z.record(TaskColumnSchema, z.array(TaskSummarySchema)),
})

// §8 Team
export const AgentsSnapshotSchema = z.object({
  asOfSeq: AsOfSeqSchema,
  items: z.array(AgentSummarySchema),
})

// §5 Chat: commands and the message POST response
export const CommandsResponseSchema = z.object({
  items: z.array(z.object({ name: z.string().min(1), usage: z.string(), description: z.string() })),
})
export const CommandResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('assign'), taskId: z.string().min(1), taskKey: z.string().min(1) }),
  z.object({ kind: z.literal('routine'), routineId: z.string().min(1) }),
  z.object({ kind: z.literal('remember'), agentIds: z.array(AgentIdSchema) }),
  z.object({ kind: z.literal('skill'), name: z.string().min(1), installed: z.boolean() }),
  z.object({ kind: z.literal('model'), model: z.string().min(1) }),
])
export type CommandResult = z.infer<typeof CommandResultSchema>
export const PostMessageResponseSchema = z.object({
  message: MessageSchema,
  routedTo: z.array(AgentIdSchema),
  command: CommandResultSchema.nullable(),
})
/** `GET /api/agents/:agentId/context` (PLAN 5.25): the agent's latest run usage and its model's context window. */
export const AgentContextSchema = z.object({
  model: z.string().nullable(),
  tokens: z.object({ input: z.int().nonnegative(), output: z.int().nonnegative() }).nullable(),
  costUsd: z.number().nonnegative().nullable(),
  contextLength: z.int().positive().nullable(),
})
export type AgentContext = z.infer<typeof AgentContextSchema>
/** `POST /api/rooms/:roomId/messages/:messageId/retry` (202): the new placeholder reply. */
export const RetryReplyResponseSchema = z.object({ messageId: z.string().min(1) })
export type RetryReplyResponse = z.infer<typeof RetryReplyResponseSchema>

// §8 Team: SOUL.md / AGENTS.md
export const AgentFileSchema = z.object({
  content: z.string(),
  etag: z.string().regex(/^[a-f0-9]{64}$/),
})
export const AgentFilePreviewSchema = z.object({ diff: z.string() })
export const AgentFileWriteSchema = AgentFileSchema.pick({ etag: true })
/** `details` of a 409 `conflict` on PUT: the current etag and a diff from the current file to the submitted one. */
export const AgentFileConflictSchema = z.object({
  etag: AgentFileSchema.shape.etag,
  diff: z.string(),
})

// §8 Team: routines (not on the stream; refetch after mutations)
export const RoutinesResponseSchema = z.object({ items: z.array(RoutineSummarySchema) })
export const RoutineDeletedSchema = z.object({ id: z.string().min(1) })
/** Run-now only marks the job due; it runs on the scheduler's next tick. */
export const RoutineRunSchema = z.object({ id: z.string().min(1), queued: z.literal(true) })

// §4 Now
export const NowSnapshotSchema = z.object({
  asOfSeq: AsOfSeqSchema,
  now: z.iso.datetime(),
  /** Pause everyone is on (POST /api/team/pause). */
  paused: z.boolean(),
  headline: z.object({
    working: z.int().nonnegative(),
    needsYou: z.int().nonnegative(),
    text: z.string(),
  }),
  lanes: z.array(z.object({ agent: AgentSummarySchema, blocks: z.array(LaneBlockSchema) })),
  handoffs: z.array(HandoffSchema),
  focusApproval: ApprovalSchema.nullable(),
  thread: z.object({ roomId: z.string().min(1), messages: z.array(MessageSchema) }).nullable(),
  madeToday: z.array(
    z.object({
      title: z.string(),
      ref: RefSchema,
      files: z.array(
        z.object({
          path: z.string(),
          added: z.int().nonnegative(),
          removed: z.int().nonnegative(),
        }),
      ),
      checks: z.array(z.object({ label: z.string(), agentId: AgentIdSchema, ok: z.boolean() })),
    }),
  ),
})
export type NowSnapshot = z.infer<typeof NowSnapshotSchema>

// §9 Reports (not on the stream; refetch)
export const ReportRangeSchema = z.enum(['today', '7d', '30d', 'custom'])
export type ReportRange = z.infer<typeof ReportRangeSchema>
export const ReportsSchema = z.object({
  range: ReportRangeSchema,
  summary: z.string(),
  totals: z.object({
    tasksFinished: z.int().nonnegative(),
    runs: z.int().nonnegative(),
    firstPassRate: z.number().min(0).max(1).nullable(),
    medianTaskSec: z.number().nonnegative().nullable(),
    spendUsd: z.number().nonnegative().nullable(),
  }),
  byDay: z.array(
    z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      perAgent: z.record(AgentIdSchema, z.int().nonnegative()),
    }),
  ),
  timeSplit: z.array(
    z.object({
      agentId: AgentIdSchema,
      workingPct: z.number().min(0).max(100),
      waitingOnYouPct: z.number().min(0).max(100),
      waitingOnAgentPct: z.number().min(0).max(100),
    }),
  ),
  byAgent: z.array(
    z.object({
      agentId: AgentIdSchema,
      finished: z.int().nonnegative(),
      runs: z.int().nonnegative(),
      medianSec: z.number().nonnegative().nullable(),
      firstPassRate: z.number().min(0).max(1).nullable(),
      spendUsd: z.number().nonnegative().nullable(),
    }),
  ),
  approvals: z.object({
    asked: z.int().nonnegative(),
    approved: z.int().nonnegative(),
    denied: z.int().nonnegative(),
    medianWaitSec: z.number().nonnegative().nullable(),
    insight: z.string().nullable(),
  }),
})
export type Reports = z.infer<typeof ReportsSchema>

// §3 Remote access: paired browsers (management ids never authenticate anything)
export const PairedBrowserSchema = z.object({
  id: z.uuid(),
  label: z.string(),
  address: z.string(),
  createdAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  current: z.boolean(),
})
export const PairedBrowsersSchema = z.object({ items: z.array(PairedBrowserSchema) })
/** "Pair another device": a one-time link for a new browser (contract §3). */
export const PairingLinkSchema = z.object({
  url: z.url({ protocol: /^https?$/ }),
  expiresAt: z.iso.datetime(),
})
export type PairingLink = z.infer<typeof PairingLinkSchema>
/** Whether the security password that guards pairing management is set (contract §3). */
export const SecurityStatusSchema = z.object({
  passwordSet: z.boolean(),
  /** Origins a pairing link may use (SCORE_PUBLIC_ORIGINS); the first is the default. */
  origins: z.array(z.url({ protocol: /^https?$/ })).default([]),
})
export const RevokeOthersResponseSchema = z.object({ revoked: z.int().nonnegative() })
export type PairedBrowser = z.infer<typeof PairedBrowserSchema>
