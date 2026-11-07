import type { ApprovalChoice } from '@score/contract'
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import type { DomainEventDraft } from '../hub/ingest.ts'
import { redactBounded } from '../redact.ts'
import { approvalMessage } from './message-runs.ts'
import { patchApproval, touchedApprovalIds, type ApprovalReadOptions } from './approval-store.ts'
import { IdSchema } from './approval-schemas.ts'
import { byRequest, replaySignals } from './approval-signals.ts'
import { insertApproval, mutate, recordChoice } from './approval-writes.ts'

export function requestRunApproval(
  sqlite: DatabaseSync,
  req: {
    profile: string
    runId: string
    requestId: string
    command: string
    description: string
    choices: ApprovalChoice[]
    patternKeys?: string[]
    expiresAt?: string
    id?: string
  },
  at: string,
  options: ApprovalReadOptions = {},
): DomainEventDraft[] {
  const drafts = mutate(sqlite, at, options, () => {
    const row = byRequest(sqlite, req.profile, req.runId, req.requestId)
    if (!row) {
      insertApproval(sqlite, {
        id: req.id ?? randomUUID(),
        origin: 'score-run',
        stage: 'human',
        target_kind: 'run_request',
        visible: 1,
        profile: req.profile,
        session_key: req.runId,
        run_id: req.runId,
        request_id: req.requestId,
        surface: 'run-sse',
        command: req.command,
        description: req.description,
        choices: req.choices,
        pattern_keys: req.patternKeys ?? [],
        created_at: at,
        ...(req.expiresAt ? { expires_at: req.expiresAt } : {}),
      })
    } else
      patchApproval(
        sqlite,
        row.id,
        {
          visible: 1,
          origin: 'score-run',
          target_kind: 'run_request',
          run_id: req.runId,
          choices: req.choices,
          command: redactBounded(req.command, 2048),
          description: redactBounded(req.description, 2048),
          pattern_keys: req.patternKeys ?? row.pattern_keys,
          ...(req.expiresAt ? { expires_at: req.expiresAt } : {}),
        },
        at,
      )
    replaySignals(sqlite, touchedApprovalIds(sqlite), at)
  })
  return [
    ...drafts,
    ...drafts.flatMap((draft) =>
      draft.type === 'approval.requested' ? approvalMessage(sqlite, draft.data.id, at) : [],
    ),
  ]
}
export function respondRunApproval(
  sqlite: DatabaseSync,
  profile: string,
  runId: string,
  requestId: string,
  choice: ApprovalChoice,
  at: string,
): DomainEventDraft[] {
  return mutate(sqlite, at, {}, () => {
    const row = byRequest(sqlite, profile, runId, requestId)
    if (row) recordChoice(sqlite, row.id, choice, at)
  })
}
export function closeRunApprovals(
  sqlite: DatabaseSync,
  runId: string,
  at: string,
): DomainEventDraft[] {
  return mutate(sqlite, at, {}, () => {
    for (const { id } of z
      .array(IdSchema)
      .parse(
        sqlite
          .prepare(
            `SELECT id FROM approvals WHERE run_id = ? AND phase IN ('guardian_evaluating', 'human_pending')`,
          )
          .all(runId),
      ))
      patchApproval(sqlite, id, { closed_reason: 'run_ended', closed_at: at }, at)
  })
}
export function expireApprovals(sqlite: DatabaseSync, at: string): DomainEventDraft[] {
  return mutate(sqlite, at, {}, () => {
    for (const { id } of z
      .array(IdSchema)
      .parse(
        sqlite
          .prepare(
            `SELECT id FROM approvals WHERE phase IN ('guardian_evaluating', 'human_pending') AND expires_at <= ?`,
          )
          .all(at),
      ))
      patchApproval(sqlite, id, { closed_reason: 'expired', closed_at: at }, at)
  })
}
