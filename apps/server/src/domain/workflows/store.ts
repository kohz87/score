import {
  WorkflowDefinitionSchema,
  type WorkflowDefinition,
  VerdictRecordSchema,
  type VerdictRecord,
} from '@score/contract'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'

// Row schemas and plain readers for the workflow tables (migration 0051).

const bool = z.int().transform((v) => v === 1)
const json = <T extends z.ZodType>(schema: T) =>
  z.string().transform((text) => schema.parse(JSON.parse(text)) as z.infer<T>)

export const WfRunRowSchema = z.object({
  orchestration_id: z.string(),
  workflow_id: z.string(),
  version: z.int(),
  workflow_name: z.string(),
  definition: json(WorkflowDefinitionSchema),
  definition_hash: z.string(),
  inputs: json(z.record(z.string(), z.string())),
  gate_policy: z.enum(['gates-only', 'every-step']),
  unknown_spend: z.enum(['pause', 'continue']),
  planner_generation: z.int(),
  graph_outcome: z.enum(['reached_end', 'failed', 'stopped']).nullable(),
  graph_reason: z.string().nullable(),
  rerun_of: z.string().nullable(),
  compacted_control: z.int(),
  created_at: z.string(),
})
export type WfRunRow = Omit<z.infer<typeof WfRunRowSchema>, 'definition'> & {
  definition: WorkflowDefinition
}

export const NODE_STATES = [
  'waiting',
  'ready',
  'gate_open',
  'running',
  'succeeded',
  'failed',
  'skipped',
  'cancelled',
  'unresolved',
] as const
export type NodeStateName = (typeof NODE_STATES)[number]

export const WfNodeRowSchema = z.object({
  orchestration_id: z.string(),
  node_id: z.string(),
  kind: z.string(),
  state: z.enum(NODE_STATES),
  revision: z.int(),
  attempts_used: z.int(),
  attempts_max: z.int(),
  step_id: z.string().nullable(),
  reason: z.string().nullable(),
  output: z.string().nullable(),
  output_truncated: bool,
  output_revision: z.int(),
  verdict: z
    .string()
    .nullable()
    .transform((v) =>
      v === null ? null : (VerdictRecordSchema.parse(JSON.parse(v)) as VerdictRecord),
    ),
  gate_id: z.string().nullable(),
  remaps: z.int(),
  started_at: z.string().nullable(),
  ended_at: z.string().nullable(),
})
export type WfNodeRow = z.infer<typeof WfNodeRowSchema>

export const WfTokenRowSchema = z.object({
  id: z.int(),
  orchestration_id: z.string(),
  edge_id: z.string(),
  kind: z.enum(['ok', 'failed', 'rejected', 'skip', 'branch']),
  produced_by: z.string(),
  produced_attempt: z.int(),
  consumed_by: z.string().nullable(),
  created_at: z.string(),
})
export type WfTokenRow = z.infer<typeof WfTokenRowSchema>

export const WfStepRowSchema = z.object({
  orchestration_id: z.string(),
  step_id: z.string(),
  node_id: z.string(),
  attempt: z.int(),
  reason: z.enum(['initial', 'retry', 'remap']),
})
export type WfStepRow = z.infer<typeof WfStepRowSchema>

export const WfConsumedRowSchema = z.object({
  orchestration_id: z.string(),
  step_id: z.string(),
  consumer: z.string(),
  consumer_attempt: z.int(),
  producer: z.string(),
  producer_attempt: z.int(),
  producer_step: z.string(),
  output_revision: z.int(),
  kind: z.enum(['output', 'failure', 'default']),
  withdrawn: bool,
})
export type WfConsumedRow = z.infer<typeof WfConsumedRowSchema>

export const WfGateRowSchema = z.object({
  orchestration_id: z.string(),
  id: z.string(),
  node_id: z.string(),
  payload: z.string(),
  payload_hash: z.string(),
  status: z.enum(['open', 'approved', 'rejected', 'withdrawn']),
  revision: z.int(),
  note: z.string().nullable(),
  created_at: z.string(),
  decided_at: z.string().nullable(),
})
export type WfGateRow = z.infer<typeof WfGateRowSchema>

export const WfCommandRowSchema = z.object({
  orchestration_id: z.string(),
  node_id: z.string(),
  attempt: z.int(),
  verb: z.enum(['assign', 'cancel', 'finish']),
  generation: z.int(),
  payload_hash: z.string(),
  receipt: z.string(),
  outcome: z.enum(['ok', 'refused']),
  created_at: z.string(),
})
export type WfCommandRow = z.infer<typeof WfCommandRowSchema>

export const WfResultRowSchema = z.object({
  attempt_id: z.string(),
  generation: z.int(),
  verdict: z.string().nullable(),
  output: z.string(),
  truncated: bool,
  full_bytes: z.int(),
  too_long: bool,
  created_at: z.string(),
})
export type WfResultRow = z.infer<typeof WfResultRowSchema>

export function readWfRun(sqlite: DatabaseSync, orchId: string): WfRunRow | undefined {
  const row = sqlite.prepare('SELECT * FROM wf_runs WHERE orchestration_id = ?').get(orchId)
  return row === undefined ? undefined : (WfRunRowSchema.parse(row) as WfRunRow)
}
export function requireWfRun(sqlite: DatabaseSync, orchId: string): WfRunRow {
  const row = readWfRun(sqlite, orchId)
  if (!row) throw new Error(`Run ${orchId} is not a workflow run`)
  return row
}
export const nodesOf = (sqlite: DatabaseSync, orchId: string): WfNodeRow[] =>
  z
    .array(WfNodeRowSchema)
    .parse(
      sqlite
        .prepare('SELECT * FROM wf_nodes WHERE orchestration_id = ? ORDER BY rowid')
        .all(orchId),
    )
export const tokensOf = (sqlite: DatabaseSync, orchId: string): WfTokenRow[] =>
  z
    .array(WfTokenRowSchema)
    .parse(
      sqlite.prepare('SELECT * FROM wf_tokens WHERE orchestration_id = ? ORDER BY id').all(orchId),
    )
export const wfStepsOf = (sqlite: DatabaseSync, orchId: string): WfStepRow[] =>
  z
    .array(WfStepRowSchema)
    .parse(
      sqlite
        .prepare('SELECT * FROM wf_steps WHERE orchestration_id = ? ORDER BY rowid')
        .all(orchId),
    )
export const consumedOf = (sqlite: DatabaseSync, orchId: string): WfConsumedRow[] =>
  z
    .array(WfConsumedRowSchema)
    .parse(
      sqlite
        .prepare('SELECT * FROM wf_consumed WHERE orchestration_id = ? ORDER BY rowid')
        .all(orchId),
    )
export const wfGatesOf = (sqlite: DatabaseSync, orchId: string): WfGateRow[] =>
  z
    .array(WfGateRowSchema)
    .parse(
      sqlite
        .prepare('SELECT * FROM wf_gates WHERE orchestration_id = ? ORDER BY rowid')
        .all(orchId),
    )
export const commandsOf = (sqlite: DatabaseSync, orchId: string): WfCommandRow[] =>
  z
    .array(WfCommandRowSchema)
    .parse(
      sqlite
        .prepare('SELECT * FROM wf_commands WHERE orchestration_id = ? ORDER BY rowid')
        .all(orchId),
    )
/**
 * The complete-reply facts of an attempt. A coding attempt names the dispatch generation that is current (its result is
 * the one that generation's run produced); a Hermes attempt has a single row.
 */
export function readResult(
  sqlite: DatabaseSync,
  attemptId: string,
  generation?: number,
): WfResultRow | undefined {
  const row =
    generation === undefined
      ? sqlite
          .prepare('SELECT * FROM wf_results WHERE attempt_id = ? ORDER BY generation DESC LIMIT 1')
          .get(attemptId)
      : sqlite
          .prepare('SELECT * FROM wf_results WHERE attempt_id = ? AND generation = ?')
          .get(attemptId, generation)
  return row === undefined ? undefined : WfResultRowSchema.parse(row)
}

export const isWorkflowRun = (sqlite: DatabaseSync, orchId: string): boolean =>
  sqlite.prepare('SELECT 1 FROM wf_runs WHERE orchestration_id = ?').get(orchId) !== undefined

/** Node row update with a revision bump. */
export function setNode(
  sqlite: DatabaseSync,
  orchId: string,
  nodeId: string,
  patch: Partial<{
    state: NodeStateName
    attempts_used: number
    step_id: string | null
    reason: string | null
    output: string | null
    output_truncated: number
    output_revision: number
    verdict: string | null
    gate_id: string | null
    remaps: number
    started_at: string | null
    ended_at: string | null
  }>,
): void {
  const keys = Object.keys(patch) as (keyof typeof patch)[]
  if (keys.length === 0) return
  sqlite
    .prepare(
      `UPDATE wf_nodes SET ${keys.map((k) => `${k} = ?`).join(', ')}, revision = revision + 1 WHERE orchestration_id = ? AND node_id = ?`,
    )
    .run(...keys.map((k) => patch[k] as string | number | null), orchId, nodeId)
}
