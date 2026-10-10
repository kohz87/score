import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { HttpError } from '../../errors.ts'

// Row schemas for the orchestration tables (migration 0048) and the plain readers the executor and routes share.

const jsonArray = z.string().transform((value) => z.array(z.string()).parse(JSON.parse(value)))
const bool = z.int().transform((value) => value === 1)

export const OrchRowSchema = z.object({
  id: z.string(),
  title: z.string(),
  goal: z.string(),
  lead_agent_id: z.string(),
  lead_incarnation: z.string(),
  allowed_agents: jsonArray,
  room_id: z.string(),
  brief_id: z.string(),
  gate_policy: z.enum(['every-step', 'lead-asks', 'none']),
  budget_usd: z.number().nullable(),
  deadline_at: z.string().nullable(),
  max_steps: z.int(),
  max_lead_turns: z.int(),
  max_concurrent_steps: z.int(),
  lead_turn_estimate_usd: z.number(),
  step_estimate_usd: z.number(),
  status: z.enum([
    'running',
    'paused',
    'stopping',
    'finishing',
    'succeeded',
    'finished_with_unresolved',
    'stopped',
    'failed',
  ]),
  pause_reason: z.string().nullable(),
  manual_paused_at: z.string().nullable(),
  plan: jsonArray,
  lead_turns_used: z.int(),
  steps_created: z.int(),
  causes_consumed_up_to: z.int(),
  consecutive_lead_failures: z.int(),
  finish_requested_at: z.string().nullable(),
  finish_attempt_id: z.string().nullable(),
  finish_outcome: z.enum(['success', 'partial', 'failed']).nullable(),
  finish_summary: z.string().nullable(),
  stop_requested_at: z.string().nullable(),
  waiver_at: z.string().nullable(),
  accepted_unknown_spend: bool,
  acknowledgement: z.string(),
  preflight: z.string(),
  reserve_bytes: z.int(),
  stored_bytes: z.int(),
  revision: z.int(),
  created_at: z.string(),
  updated_at: z.string(),
  ended_at: z.string().nullable(),
  end_reason: z.string().nullable(),
})
export type OrchRow = z.infer<typeof OrchRowSchema>

export const TERMINAL_STATUSES = [
  'succeeded',
  'finished_with_unresolved',
  'stopped',
  'failed',
] as const
export const isTerminalStatus = (status: OrchRow['status']): boolean =>
  (TERMINAL_STATUSES as readonly string[]).includes(status)

export const StepRowSchema = z.object({
  orchestration_id: z.string(),
  id: z.string(),
  seq: z.int(),
  agent_id: z.string(),
  agent_incarnation: z.string(),
  instruction: z.string(),
  after_steps: jsonArray,
  replaces: z.string().nullable(),
  status: z.enum([
    'pending_gate',
    'queued',
    'admitted',
    'succeeded',
    'failed',
    'unknown',
    'cancelled',
    'blocked',
    'rejected',
    'not_started',
  ]),
  disposition: z.string().nullable(),
  estimate_usd: z.number(),
  result: z.string().nullable(),
  result_revision: z.int(),
  retired: bool,
  created_in_attempt: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
})
export type StepRow = z.infer<typeof StepRowSchema>

export const FINAL_STEP_STATUSES = [
  'succeeded',
  'failed',
  'cancelled',
  'blocked',
  'rejected',
  'not_started',
] as const
export const isFinalStep = (status: StepRow['status']): boolean =>
  (FINAL_STEP_STATUSES as readonly string[]).includes(status)

export const AttemptRowSchema = z.object({
  id: z.string(),
  orchestration_id: z.string(),
  kind: z.enum(['lead', 'step']),
  step_id: z.string().nullable(),
  n: z.int(),
  agent_id: z.string(),
  agent_incarnation: z.string(),
  session_id: z.string(),
  turn_id: z.string(),
  message_id: z.string(),
  state: z.enum([
    'created',
    'send_started',
    'running',
    'terminated',
    'unknown',
    'refused',
    'abandoned',
  ]),
  input: z.string(),
  run_id: z.string().nullable(),
  retired: bool,
  stop_requested_at: z.string().nullable(),
  stop_acknowledged_at: z.string().nullable(),
  terminated_at: z.string().nullable(),
  evidence: z.enum(['completed', 'failed']).nullable(),
  unknown_reason: z.string().nullable(),
  reserved_usd: z.number(),
  spend_usd: z.number().nullable(),
  spend_complete: bool,
  settled: bool,
  claim_from: z.int().nullable(),
  claim_to: z.int().nullable(),
  commands: z.int(),
  sent_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  abandoned_at: z.string().nullable(),
})
export type AttemptRow = z.infer<typeof AttemptRowSchema>

/** States in which the attempt may still be (or become) a live Hermes run: they hold capacity and fence admissions. */
export const LIVE_ATTEMPT_STATES = ['created', 'send_started', 'running', 'unknown'] as const
/** States in which a run may exist in Hermes (a `created` attempt was never sent). */
export const MAY_RUN_STATES = ['send_started', 'running', 'unknown'] as const

export const GateRowSchema = z.object({
  orchestration_id: z.string(),
  id: z.string(),
  step_id: z.string(),
  requested_by: z.enum(['policy', 'lead']),
  payload: z.string(),
  payload_hash: z.string(),
  status: z.enum(['open', 'approved', 'rejected', 'withdrawn']),
  revision: z.int(),
  note: z.string().nullable(),
  created_at: z.string(),
  decided_at: z.string().nullable(),
})
export type GateRow = z.infer<typeof GateRowSchema>

export const InquiryRowSchema = z.object({
  orchestration_id: z.string(),
  id: z.string(),
  attempt_id: z.string(),
  question: z.string(),
  status: z.enum(['open', 'answered', 'withdrawn']),
  answer: z.string().nullable(),
  revision: z.int(),
  created_at: z.string(),
  answered_at: z.string().nullable(),
})
export type InquiryRow = z.infer<typeof InquiryRowSchema>

export function readOrch(sqlite: DatabaseSync, id: string): OrchRow | undefined {
  const row = sqlite.prepare('SELECT * FROM orchestrations WHERE id = ?').get(id)
  return row === undefined ? undefined : OrchRowSchema.parse(row)
}
export function requireOrch(sqlite: DatabaseSync, id: string): OrchRow {
  const row = readOrch(sqlite, id)
  if (!row) throw new HttpError(404, 'not_found', 'Unknown orchestration')
  return row
}
export const listOrchs = (sqlite: DatabaseSync): OrchRow[] =>
  z
    .array(OrchRowSchema)
    .parse(sqlite.prepare('SELECT * FROM orchestrations ORDER BY created_at DESC, id').all())

export const stepsOf = (sqlite: DatabaseSync, orchId: string): StepRow[] =>
  z
    .array(StepRowSchema)
    .parse(
      sqlite.prepare('SELECT * FROM orc_steps WHERE orchestration_id = ? ORDER BY seq').all(orchId),
    )
export function readStep(
  sqlite: DatabaseSync,
  orchId: string,
  stepId: string,
): StepRow | undefined {
  const row = sqlite
    .prepare('SELECT * FROM orc_steps WHERE orchestration_id = ? AND id = ?')
    .get(orchId, stepId)
  return row === undefined ? undefined : StepRowSchema.parse(row)
}
export const attemptsOf = (sqlite: DatabaseSync, orchId: string): AttemptRow[] =>
  z
    .array(AttemptRowSchema)
    .parse(
      sqlite
        .prepare('SELECT * FROM orc_attempts WHERE orchestration_id = ? ORDER BY created_at, rowid')
        .all(orchId),
    )
export function readAttempt(sqlite: DatabaseSync, id: string): AttemptRow | undefined {
  const row = sqlite.prepare('SELECT * FROM orc_attempts WHERE id = ?').get(id)
  return row === undefined ? undefined : AttemptRowSchema.parse(row)
}
export const gatesOf = (sqlite: DatabaseSync, orchId: string): GateRow[] =>
  z
    .array(GateRowSchema)
    .parse(
      sqlite
        .prepare('SELECT * FROM orc_gates WHERE orchestration_id = ? ORDER BY rowid')
        .all(orchId),
    )
export function readGate(
  sqlite: DatabaseSync,
  orchId: string,
  gateId: string,
): GateRow | undefined {
  const row = sqlite
    .prepare('SELECT * FROM orc_gates WHERE orchestration_id = ? AND id = ?')
    .get(orchId, gateId)
  return row === undefined ? undefined : GateRowSchema.parse(row)
}
export const inquiriesOf = (sqlite: DatabaseSync, orchId: string): InquiryRow[] =>
  z
    .array(InquiryRowSchema)
    .parse(
      sqlite
        .prepare('SELECT * FROM orc_inquiries WHERE orchestration_id = ? ORDER BY rowid')
        .all(orchId),
    )

export const CauseRowSchema = z.object({
  id: z.int(),
  kind: z.string(),
  ref: z.string().nullable(),
  detail: z.string().nullable(),
  at: z.string(),
})
export type CauseRow = z.infer<typeof CauseRowSchema>
export const causesAfter = (sqlite: DatabaseSync, orchId: string, after: number): CauseRow[] =>
  z
    .array(CauseRowSchema)
    .parse(
      sqlite
        .prepare(
          'SELECT id, kind, ref, detail, at FROM orc_causes WHERE orchestration_id = ? AND id > ? ORDER BY id',
        )
        .all(orchId, after),
    )

export function addCause(
  sqlite: DatabaseSync,
  orchId: string,
  kind: string,
  ref: string | null,
  now: string,
  detail: string | null = null,
): void {
  sqlite
    .prepare(
      'INSERT INTO orc_causes (orchestration_id, kind, ref, detail, at) VALUES (?, ?, ?, ?, ?)',
    )
    .run(orchId, kind, ref, detail, now)
}

export function addHistory(
  sqlite: DatabaseSync,
  orchId: string | null,
  kind: string,
  detail: unknown,
  now: string,
): void {
  sqlite
    .prepare('INSERT INTO orc_history (orchestration_id, kind, detail, at) VALUES (?, ?, ?, ?)')
    .run(orchId, kind, JSON.stringify(detail), now)
}

/** The incarnation the run froze for an agent (the lead and every allowed agent), or undefined for any other agent. */
export function frozenIncarnation(
  sqlite: DatabaseSync,
  orchId: string,
  agentId: string,
): string | undefined {
  const row = sqlite
    .prepare('SELECT incarnation FROM orc_agent_map WHERE orchestration_id = ? AND agent_id = ?')
    .get(orchId, agentId) as { incarnation: string } | undefined
  return row?.incarnation
}
