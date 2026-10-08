import { z } from 'zod'
import {
  AgentSummarySchema,
  ApprovalSchema,
  MessageSchema,
  RoomSchema,
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
