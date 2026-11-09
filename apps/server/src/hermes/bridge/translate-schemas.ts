import { BridgeIdentifierSchema } from '@score/contract'
import { z } from 'zod'
import { WatchInfoSchema } from '../../domain/watch-frames.ts'
import { defineLifecycle } from '../../hub/projections.ts'

export interface BridgeMetrics {
  unknownHooks: number
  mismatchedKanbanTasks?: number
}

export const ToolPayloadSchema = z.object({
  gateIds: z.array(BridgeIdentifierSchema).max(16).optional(),
  tool_name: z.string().optional(),
  args: z.unknown().optional(),
  result: z.unknown().optional(),
  status: z.string().nullish(),
  duration_ms: z.int().nonnegative().nullish(),
  command_digest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullish(),
  // PLAN 11.1d: a finished call's exact arguments, digested by the plugin (canonical JSON).
  args_digest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullish(),
  // The plugin's redacted terminal tail; a malformed one only costs the frame its output.
  watch: WatchInfoSchema.optional().catch(undefined),
})
export type ToolPayload = z.infer<typeof ToolPayloadSchema>

export const ExpirySchema = z.union([
  z.iso.datetime(),
  z
    .number()
    .finite()
    .nonnegative()
    .max(253402300799)
    .transform((value) => new Date(value * 1000).toISOString()),
])
export const ApprovalPayloadSchema = z.object({
  requestId: BridgeIdentifierSchema.nullable().optional(),
  request_id: BridgeIdentifierSchema.nullable().optional(),
  gateId: BridgeIdentifierSchema.nullish(),
  linkedGateId: BridgeIdentifierSchema.nullish(),
  supersedesGateId: BridgeIdentifierSchema.nullish(),
  transportRequestId: BridgeIdentifierSchema.nullish(),
})
export type ApprovalPayload = z.infer<typeof ApprovalPayloadSchema>

export const GapPayloadSchema = z
  .object({
    from_counter: z.int().positive(),
    to_counter: z.int().positive(),
    dropped: z.int().positive(),
    corrupt_records: z.int().nonnegative().optional(),
  })
  .refine(
    (gap) =>
      gap.to_counter >= gap.from_counter && gap.dropped === gap.to_counter - gap.from_counter + 1,
  )
export type GapPayload = z.infer<typeof GapPayloadSchema>

export const ToolRowSchema = z.object({
  started_at: z.iso.datetime(),
  version: z.int().nonnegative(),
})
export const lifecycle = defineLifecycle({
  states: ['running', 'ok', 'error', 'blocked'],
  terminal: ['ok', 'error', 'blocked'],
  order: ['running', 'ok', 'error', 'blocked'],
})
export const approvalHooks = new Set([
  'pre_approval_request',
  'post_approval_response',
  'on_human_input_request',
  'on_human_input_resolved',
  'approval.settled',
])
export const systemHooks = new Set([
  'on_session_start',
  'on_session_end',
  'subagent_start',
  'subagent_stop',
  'on_kanban_worker_spawned',
  'on_kanban_worker_exited',
  'on_kanban_worker_stale_claim',
  'on_kanban_task_updated',
  'on_kanban_dispatch_tick',
])

export const SubagentStartSchema = z.object({
  parent_session_id: z.string().min(1).nullish(),
  /** The session Score knows the job by: after a compression the parent's id is a new one. */
  policy_session_id: z.string().min(1).nullish(),
  child_session_id: z.string().min(1).nullish(),
  child_goal: z.string().nullish(),
})
export const SubagentStopSchema = z.object({
  child_session_id: z.string().min(1).nullish(),
  /** The id the child started under: its own changes if it compresses. */
  child_root_session_id: z.string().min(1).nullish(),
  child_status: z.string().nullish(),
})

// Hermes 0.22.5 session hooks (decision 129): a deleted session moves Score's room to a successor; a compaction is
// logged.
export const DeleteSchema = z.object({
  session_id: z.unknown().optional(),
  reason: z.string().max(64).nullish(),
  deleted_ids: z.array(z.unknown()).nullish(),
})
export type DeletePayload = z.infer<typeof DeleteSchema>

/** Each id on its own: one odd id (or a long sweep) must not hide the others. */
export const sessionIds = (values: unknown[]): string[] => [
  ...new Set(
    values.flatMap((value) => {
      const id = BridgeIdentifierSchema.safeParse(value)
      return id.success ? [id.data] : []
    }),
  ),
]

export const CompactionSchema = z.object({
  messages_removed: z.int().nonnegative().nullish(),
  before_tokens: z.int().nonnegative().nullish(),
  after_tokens: z.int().nonnegative().nullish(),
})
export type CompactionPayload = z.infer<typeof CompactionSchema>
