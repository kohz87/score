import { ApprovalChoiceSchema, ApprovalSchema, type Approval } from '@score/contract'
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { z } from 'zod'
import type { DomainEventDraft } from '../hub/ingest.ts'

const jsonStrings = z.string().transform((value) => z.array(z.string()).parse(JSON.parse(value)))
export const ApprovalRowSchema = z.object({
  id: z.string(),
  origin: ApprovalSchema.shape.origin,
  stage: z.enum(['guardian', 'human']),
  target_kind: z.enum(['run_request', 'gateway_request', 'transport', 'kanban_grant', 'none']),
  visible: z.int().min(0).max(1),
  profile: z.string(),
  session_key: z.string(),
  run_id: z.string().nullable(),
  request_id: z.string().nullable(),
  transport_request_id: z.string().nullable(),
  producer_id: z.string().nullable(),
  producer_incarnation: z.string().nullable(),
  gate_id: z.string().nullable(),
  tool_call_id: z.string().nullable(),
  turn_id: z.string().nullable(),
  hook_session_id: z.string().nullable(),
  surface: z.string(),
  coalesced: z.int().min(0).max(1),
  linked_to: z.string().nullable(),
  kanban_task_id: z.string().nullable(),
  kanban_run_id: z.int().nullable(),
  command: z.string(),
  command_digest: z.string().nullable(),
  description: z.string(),
  pattern_keys: jsonStrings,
  choices: z.string().transform((v) => z.array(ApprovalChoiceSchema).parse(JSON.parse(v))),
  guardian_verdict: z.enum(['approve', 'deny', 'escalate']).nullable(),
  decision_choice: ApprovalChoiceSchema.nullable(),
  decision_by: ApprovalSchema.shape.decision.unwrap().shape.by.nullable(),
  decided_at: z.iso.datetime().nullable(),
  closed_reason: z.string().nullable(),
  closed_at: z.iso.datetime().nullable(),
  tool_outcome: z.enum(['ok', 'blocked', 'error']).nullable(),
  phase: ApprovalSchema.shape.phase,
  status: ApprovalSchema.shape.status,
  blocking: z.string().nullable(),
  created_at: z.iso.datetime(),
  expires_at: z.iso.datetime().nullable(),
  updated_at: z.iso.datetime(),
  version: z.int().nonnegative(),
})
export type ApprovalRow = z.infer<typeof ApprovalRowSchema>
export const DeliveryRowSchema = z.object({
  id: z.string(),
  approval_id: z.string(),
  choice: ApprovalChoiceSchema,
  note: z.string().nullable(),
  route: z.enum(['port', 'bridge']),
  producer_id: z.string().nullable(),
  state: z.enum(['intent', 'delivering', 'applied', 'not_pending', 'failed', 'unknown']),
  maybe_applied: z.int().min(0).max(1),
  cycle: z.int().positive(),
  cycle_attempts: z.int().nonnegative(),
  lease_id: z.string().nullable(),
  lease_until: z.int().nullable(),
  next_attempt_at: z.int().nullable(),
  error: z.string().nullable(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
})
export type DeliveryRow = z.infer<typeof DeliveryRowSchema>
export interface ApprovalReadOptions {
  now?: number
  disabled?: readonly string[]
}

export function readApprovalRow(sqlite: DatabaseSync, id: string): ApprovalRow | undefined {
  const value = sqlite.prepare('SELECT * FROM approvals WHERE id = ?').get(id)
  return value === undefined ? undefined : ApprovalRowSchema.parse(value)
}
export function readDelivery(sqlite: DatabaseSync, approvalId: string): DeliveryRow | undefined {
  const value = sqlite
    .prepare('SELECT * FROM approval_deliveries WHERE approval_id = ?')
    .get(approvalId)
  return value === undefined ? undefined : DeliveryRowSchema.parse(value)
}

export function deriveApproval(
  row: Pick<
    ApprovalRow,
    | 'stage'
    | 'linked_to'
    | 'guardian_verdict'
    | 'decision_choice'
    | 'closed_reason'
    | 'tool_outcome'
  >,
  delivery: DeliveryRow['state'] | 'none' = 'none',
): Pick<Approval, 'phase' | 'status'> {
  if (row.stage === 'guardian') {
    if (row.linked_to) return { phase: 'escalated', status: 'withdrawn' }
    if (row.guardian_verdict === 'approve' || row.guardian_verdict === 'deny')
      return { phase: 'decided', status: row.guardian_verdict === 'deny' ? 'denied' : 'approved' }
  } else if (row.decision_choice) {
    return {
      phase: row.tool_outcome === 'ok' ? 'executed' : row.tool_outcome ? 'blocked' : 'decided',
      status: row.decision_choice === 'deny' ? 'denied' : 'approved',
    }
  }
  if (row.closed_reason) {
    if (['timeout', 'expired'].includes(row.closed_reason))
      return { phase: 'expired', status: 'expired' }
    return {
      phase: 'withdrawn',
      status:
        ['superseded', 'run_ended'].includes(row.closed_reason) &&
        ['delivering', 'unknown'].includes(delivery)
          ? 'unknown'
          : 'withdrawn',
    }
  }
  return {
    phase: row.stage === 'guardian' ? 'guardian_evaluating' : 'human_pending',
    status: 'pending',
  }
}

export function routeFeature(row: ApprovalRow): string | undefined {
  return row.target_kind === 'run_request'
    ? 'score-runs'
    : row.target_kind === 'gateway_request'
      ? 'gateway-approvals'
      : undefined
}
export function actionable(
  sqlite: DatabaseSync,
  row: ApprovalRow,
  options: ApprovalReadOptions = {},
): boolean {
  const { now = Date.now(), disabled = [] } = options
  const delivery = readDelivery(sqlite, row.id)
  if (
    !row.visible ||
    row.stage !== 'human' ||
    row.phase !== 'human_pending' ||
    !row.request_id ||
    row.coalesced ||
    (row.expires_at && Date.parse(row.expires_at) <= now) ||
    (delivery && !(delivery.state === 'failed' && !delivery.maybe_applied))
  )
    return false
  const feature = routeFeature(row)
  if (!feature || disabled.includes(feature)) return false
  if (row.target_kind === 'run_request') {
    const value = sqlite
      .prepare('SELECT profile, origin, status FROM runs WHERE id = ?')
      .get(row.run_id ?? '')
    if (!value) return false
    const run = z
      .object({ profile: z.string(), origin: z.string(), status: z.string() })
      .parse(value)
    return (
      run.profile === row.profile &&
      run.origin === 'score' &&
      ['queued', 'running', 'waiting_for_approval'].includes(run.status)
    )
  }
  const value = sqlite
    .prepare('SELECT gateway_approvals, last_seen_at FROM producers WHERE id = ?')
    .get(row.producer_id ?? '')
  if (!value) return false
  const producer = z
    .object({ gateway_approvals: z.int(), last_seen_at: z.iso.datetime() })
    .parse(value)
  return producer.gateway_approvals === 1 && Date.parse(producer.last_seen_at) >= now - 120_000
}
export function deliverable(row: ApprovalRow, delivery: DeliveryRow, now: number): boolean {
  return (
    row.phase === 'human_pending' &&
    (!row.expires_at || Date.parse(row.expires_at) > now) &&
    (delivery.route === 'port' ||
      (delivery.producer_id !== null && delivery.producer_id === row.producer_id))
  )
}
export function approvalView(
  sqlite: DatabaseSync,
  row: ApprovalRow,
  options: ApprovalReadOptions = {},
): Approval {
  const target = row.linked_to ? readApprovalRow(sqlite, row.linked_to) : undefined
  return ApprovalSchema.parse({
    id: row.id,
    origin: row.origin,
    phase: row.phase,
    status: row.status,
    actionable: actionable(sqlite, row, options),
    linkedTo: target?.visible ? target.id : null,
    agentId: row.profile,
    title: (row.description.split('\n')[0] || row.pattern_keys[0] || '').slice(0, 120),
    command: row.command,
    cwd: null,
    description: row.description,
    choices: row.choices,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    decision:
      row.decision_choice && row.decision_by && row.decided_at
        ? { choice: row.decision_choice, by: row.decision_by, at: row.decided_at }
        : null,
    delivery: readDelivery(sqlite, row.id)?.state ?? 'none',
    blocking: row.blocking,
    refs: row.run_id ? [{ kind: 'run', runId: row.run_id }] : [],
  })
}

const journals = new WeakMap<DatabaseSync, Map<string, number | undefined>>()
export function trackApproval(sqlite: DatabaseSync, id: string, visible: number | undefined): void {
  const journal = journals.get(sqlite)
  if (journal && !journal.has(id)) journal.set(id, visible)
}
export function touchedApprovalIds(sqlite: DatabaseSync): string[] {
  return [...(journals.get(sqlite)?.keys() ?? [])]
}
export function collectApprovalChanges(
  sqlite: DatabaseSync,
  work: () => void,
): Map<string, number | undefined> {
  if (!sqlite.isTransaction) throw new Error('Approval mutations require a transaction')
  if (journals.has(sqlite)) throw new Error('Nested approval mutations are not supported')
  const journal = new Map<string, number | undefined>()
  journals.set(sqlite, journal)
  try {
    work()
    return journal
  } finally {
    journals.delete(sqlite)
  }
}

// Column names come only from these internal typed schemas, never from an external input.
export function patchApproval(
  sqlite: DatabaseSync,
  id: string,
  values: Partial<ApprovalRow>,
  at: string,
): void {
  if (!sqlite.isTransaction) throw new Error('Approval mutations require a transaction')
  const columns = Object.entries(values).filter(
    ([key]) => !['id', 'version', 'updated_at'].includes(key),
  )
  const entries = columns.map(
    ([key, value]) => [key, Array.isArray(value) ? JSON.stringify(value) : value] as const,
  )
  if (!entries.length) return
  trackApproval(sqlite, id, readApprovalRow(sqlite, id)?.visible)
  sqlite
    .prepare(
      `UPDATE approvals SET ${entries.map(([key]) => `${key} = ?`).join(', ')}, updated_at = ?, version = version + 1 WHERE id = ?`,
    )
    .run(...entries.map(([, value]) => value as SQLInputValue), at, id)
  const row = readApprovalRow(sqlite, id)!
  const derived = deriveApproval(row, readDelivery(sqlite, id)?.state)
  sqlite
    .prepare('UPDATE approvals SET phase = ?, status = ? WHERE id = ?')
    .run(derived.phase, derived.status, id)
}
export function refreshApproval(sqlite: DatabaseSync, id: string, at: string): void {
  const row = readApprovalRow(sqlite, id)!
  patchApproval(sqlite, id, deriveApproval(row, readDelivery(sqlite, id)?.state), at)
}
export function approvalDraft(
  sqlite: DatabaseSync,
  id: string,
  options: ApprovalReadOptions = {},
  requested = false,
): DomainEventDraft[] {
  const row = readApprovalRow(sqlite, id)
  // A hidden stage record folded into its visible card is deleted in the same transaction.
  return row?.visible
    ? [
        {
          type: requested ? 'approval.requested' : 'approval.updated',
          data: approvalView(sqlite, row, options),
        },
      ]
    : []
}
