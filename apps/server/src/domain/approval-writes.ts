import type { ApprovalChoice } from '@score/contract'
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { DomainEventDraft } from '../hub/ingest.ts'
import { redactBounded } from '../redact.ts'
import {
  ApprovalRowSchema,
  collectApprovalChanges,
  trackApproval,
  approvalDraft,
  patchApproval,
  readApprovalRow,
  readDelivery,
  type ApprovalReadOptions,
  type ApprovalRow,
} from './approval-store.ts'
import { IdSchema } from './approval-schemas.ts'

export function insertApproval(
  sqlite: DatabaseSync,
  values: Partial<ApprovalRow> &
    Pick<ApprovalRow, 'profile' | 'session_key' | 'command' | 'description' | 'created_at'>,
): string {
  const row = ApprovalRowSchema.parse({
    id: randomUUID(),
    origin: 'gateway',
    stage: 'human',
    target_kind: 'none',
    visible: 1,
    run_id: null,
    request_id: null,
    transport_request_id: null,
    producer_id: null,
    producer_incarnation: null,
    gate_id: null,
    tool_call_id: null,
    turn_id: null,
    hook_session_id: null,
    surface: 'unknown',
    coalesced: 0,
    linked_to: null,
    kanban_task_id: null,
    kanban_run_id: null,
    command_digest: null,
    guardian_verdict: null,
    decision_choice: null,
    decision_by: null,
    decided_at: null,
    closed_reason: null,
    closed_at: null,
    tool_outcome: null,
    phase: values.stage === 'guardian' ? 'guardian_evaluating' : 'human_pending',
    status: 'pending',
    blocking: null,
    expires_at: new Date(Date.parse(values.created_at) + 3600_000).toISOString(),
    updated_at: values.created_at,
    version: 0,
    ...values,
    command: redactBounded(values.command, 2048),
    description: redactBounded(values.description, 2048),
    pattern_keys: JSON.stringify(values.pattern_keys ?? []),
    choices: JSON.stringify(values.choices ?? ['once', 'session', 'always', 'deny']),
  })
  const stored = {
    ...row,
    pattern_keys: JSON.stringify(row.pattern_keys),
    choices: JSON.stringify(row.choices),
  }
  trackApproval(sqlite, row.id, undefined)
  const columns = Object.keys(stored)
  sqlite
    .prepare(
      `INSERT INTO approvals (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    )
    .run(...Object.values(stored))
  return row.id
}

// Capture changes once and emit the final projection, including links revealed by a hidden target.
export function mutate(
  sqlite: DatabaseSync,
  at: string,
  options: ApprovalReadOptions,
  work: () => void,
): DomainEventDraft[] {
  const journal = collectApprovalChanges(sqlite, work)
  const visibleTargets = [...journal]
    .filter(([id, before]) => readApprovalRow(sqlite, id)?.visible !== before)
    .map(([id]) => id)
  for (const id of visibleTargets) {
    for (const value of sqlite.prepare('SELECT id FROM approvals WHERE linked_to = ?').all(id)) {
      const guardian = readApprovalRow(sqlite, IdSchema.parse(value).id)!
      if (!journal.has(guardian.id)) journal.set(guardian.id, guardian.visible)
    }
  }
  return [...journal].flatMap(([id, before]) =>
    approvalDraft(sqlite, id, { ...options, now: options.now ?? Date.parse(at) }, !before),
  )
}

export function recordChoice(
  sqlite: DatabaseSync,
  id: string,
  choice: ApprovalChoice,
  at: string,
): void {
  const row = readApprovalRow(sqlite, id)!
  const delivery = readDelivery(sqlite, id)
  // Conflicting evidence cannot overwrite a known choice. A verified receipt is reconciled separately.
  if (row.decision_choice && row.decision_choice !== choice) {
    if (delivery?.state === 'applied' && row.decision_by === 'you') {
      sqlite
        .prepare(
          `UPDATE approval_deliveries SET state = 'unknown', maybe_applied = 1, error = 'choice_mismatch', updated_at = ? WHERE id = ?`,
        )
        .run(at, delivery.id)
      patchApproval(
        sqlite,
        id,
        { decision_choice: choice, decision_by: 'elsewhere', decided_at: at },
        at,
      )
    }
    return
  }
  patchApproval(
    sqlite,
    id,
    {
      decision_choice: choice,
      decision_by:
        delivery?.state === 'applied' && delivery.choice === choice ? 'you' : 'elsewhere',
      decided_at: row.decided_at ?? at,
    },
    at,
  )
}
