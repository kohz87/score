import { ApprovalChoiceSchema, type ApprovalChoice } from '@score/contract'
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import type { DomainEventDraft } from '../hub/ingest.ts'
import { redactBounded } from '../redact.ts'
import {
  ApprovalRowSchema,
  collectApprovalChanges,
  trackApproval,
  touchedApprovalIds,
  approvalDraft,
  patchApproval,
  readApprovalRow,
  readDelivery,
  type ApprovalReadOptions,
  type ApprovalRow,
} from './approval-store.ts'

export { deriveApproval, approvalView, readApprovalRow } from './approval-store.ts'

export const GateSignalSchema = z.object({
  kind: z.enum(['pre', 'post', 'closed']),
  surface: z.string().default('unknown'),
  command: z.string().default(''),
  description: z.string().default(''),
  pattern_keys: z.array(z.string()).default([]),
  pattern_key: z.string().nullish(),
  allow_session: z.boolean().optional(),
  allow_permanent: z.boolean().optional(),
  coalesced: z.boolean().default(false),
  choice: z.string().optional(),
  commandDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullish(),
  command_digest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullish(),
  toolCallId: z.string().nullish(),
  turnId: z.string().nullish(),
  sessionId: z.string().nullish(),
  supersedesGateId: z.string().nullish(),
  expiresAt: z.iso.datetime().nullish(),
})
const SignalRowSchema = z.object({
  id: z.int(),
  producer_id: z.string(),
  profile: z.string(),
  session_key: z.string().nullable(),
  request_id: z.string().nullable(),
  producer_incarnation: z.string().nullable(),
  counter: z.int().nullable(),
  gate_id: z.string().nullable(),
  linked_gate_id: z.string().nullable(),
  transport_request_id: z.string().nullable(),
  matched_approval_id: z.string().nullable(),
  payload: z.string().transform((v) => GateSignalSchema.parse(JSON.parse(v))),
  at: z.iso.datetime(),
})
type Signal = z.infer<typeof SignalRowSchema>
const IdSchema = z.object({ id: z.string() })
function byGate(
  sqlite: DatabaseSync,
  incarnation: string | null,
  gate: string | null,
): ApprovalRow | undefined {
  if (!incarnation || !gate) return
  const value = sqlite
    .prepare('SELECT id FROM approvals WHERE producer_incarnation = ? AND gate_id = ?')
    .get(incarnation, gate)
  return value ? readApprovalRow(sqlite, IdSchema.parse(value).id) : undefined
}
function byRequest(
  sqlite: DatabaseSync,
  profile: string,
  session: string | null,
  request: string | null,
): ApprovalRow | undefined {
  if (!session || !request) return
  const value = sqlite
    .prepare('SELECT id FROM approvals WHERE profile = ? AND session_key = ? AND request_id = ?')
    .get(profile, session, request)
  return value ? readApprovalRow(sqlite, IdSchema.parse(value).id) : undefined
}
function scoreRun(sqlite: DatabaseSync, profile: string, session: string): boolean {
  const value = sqlite.prepare('SELECT origin, profile FROM runs WHERE id = ?').get(session)
  if (!value) return false
  const run = z.object({ origin: z.string(), profile: z.string() }).parse(value)
  return run.origin === 'score' && run.profile === profile
}
function insertApproval(
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
function mutate(
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
function linkSignal(sqlite: DatabaseSync, signal: Signal, row: ApprovalRow, at: string): void {
  const guardian = byGate(sqlite, signal.producer_incarnation, signal.linked_gate_id)
  if (guardian?.stage === 'guardian' && (!guardian.linked_to || guardian.linked_to === row.id)) {
    if (guardian.linked_to !== row.id)
      patchApproval(
        sqlite,
        guardian.id,
        { linked_to: row.id, guardian_verdict: guardian.guardian_verdict ?? 'escalate' },
        at,
      )
    if (guardian.guardian_verdict === 'deny' && row.choices.join(',') !== 'once,deny')
      patchApproval(sqlite, row.id, { choices: ['once', 'deny'] }, at)
  }
  const superseded = byGate(
    sqlite,
    signal.producer_incarnation,
    signal.payload.supersedesGateId ?? null,
  )
  if (superseded && superseded.id !== row.id && !superseded.closed_reason)
    patchApproval(sqlite, superseded.id, { closed_reason: 'superseded', closed_at: signal.at }, at)
}
// A hidden Score-run hook stage and the visible run-SSE card are the same gate once a signal carries both its gate id
// and its exact request id. Hidden rows were never emitted, so folding one into the card is invisible to clients.
function foldHidden(
  sqlite: DatabaseSync,
  hidden: ApprovalRow,
  visible: ApprovalRow,
  at: string,
): ApprovalRow | undefined {
  if (
    hidden.visible ||
    !visible.visible ||
    hidden.stage !== 'human' ||
    visible.stage !== 'human' ||
    hidden.profile !== visible.profile ||
    hidden.session_key !== visible.session_key ||
    (visible.gate_id && visible.gate_id !== hidden.gate_id)
  )
    return
  sqlite
    .prepare('UPDATE approval_signals SET matched_approval_id = ? WHERE matched_approval_id = ?')
    .run(visible.id, hidden.id)
  sqlite
    .prepare('UPDATE approvals SET linked_to = ? WHERE linked_to = ?')
    .run(visible.id, hidden.id)
  sqlite.prepare('DELETE FROM approvals WHERE id = ?').run(hidden.id)
  patchApproval(
    sqlite,
    visible.id,
    {
      producer_id: hidden.producer_id,
      producer_incarnation: hidden.producer_incarnation,
      gate_id: hidden.gate_id,
      tool_call_id: hidden.tool_call_id,
      turn_id: hidden.turn_id,
      hook_session_id: hidden.hook_session_id,
      ...(!visible.closed_reason && hidden.closed_reason
        ? { closed_reason: hidden.closed_reason, closed_at: hidden.closed_at }
        : {}),
      ...(!visible.tool_outcome && hidden.tool_outcome
        ? { tool_outcome: hidden.tool_outcome }
        : {}),
    },
    at,
  )
  // Re-derive attribution against the card's own delivery.
  if (hidden.decision_choice)
    recordChoice(sqlite, visible.id, hidden.decision_choice, hidden.decided_at ?? at)
  for (const value of sqlite
    .prepare('SELECT id FROM approvals WHERE linked_to = ?')
    .all(visible.id)) {
    const guardian = readApprovalRow(sqlite, IdSchema.parse(value).id)!
    if (guardian.guardian_verdict === 'deny')
      patchApproval(sqlite, visible.id, { choices: ['once', 'deny'] }, at)
  }
  return readApprovalRow(sqlite, visible.id)
}
function applySignal(sqlite: DatabaseSync, signal: Signal, at: string): boolean {
  const p = signal.payload
  let row = signal.matched_approval_id
    ? readApprovalRow(sqlite, signal.matched_approval_id)
    : byGate(sqlite, signal.producer_incarnation, signal.gate_id)
  if (p.kind === 'pre') {
    if (!signal.gate_id || !signal.producer_incarnation || !signal.session_key) return false
    const run = scoreRun(sqlite, signal.profile, signal.session_key)
    const smart = p.surface === 'smart'
    const transport = p.surface.startsWith('transport:')
    const requestRow =
      !smart && !transport
        ? byRequest(sqlite, signal.profile, signal.session_key, signal.request_id)
        : undefined
    if (row && requestRow && row.id !== requestRow.id) {
      const folded = foldHidden(sqlite, row, requestRow, at)
      if (!folded) return false
      row = folded
    }
    row ??= requestRow
    if (
      row &&
      (row.profile !== signal.profile ||
        row.session_key !== signal.session_key ||
        row.stage !== (smart ? 'guardian' : 'human') ||
        (row.producer_incarnation && row.producer_incarnation !== signal.producer_incarnation) ||
        (row.request_id && signal.request_id && row.request_id !== signal.request_id))
    )
      return false
    if (!row) {
      const id = insertApproval(sqlite, {
        profile: signal.profile,
        session_key: signal.session_key,
        created_at: signal.at,
        origin: run ? 'score-run' : 'gateway',
        stage: smart ? 'guardian' : 'human',
        target_kind: smart
          ? 'none'
          : transport
            ? 'transport'
            : signal.request_id
              ? run
                ? 'run_request'
                : 'gateway_request'
              : 'none',
        visible: !smart && !transport && run && !signal.request_id ? 0 : 1,
        run_id: run ? signal.session_key : null,
        request_id: smart || transport ? null : signal.request_id,
        producer_id: signal.producer_id,
        producer_incarnation: signal.producer_incarnation,
        gate_id: signal.gate_id,
        transport_request_id: signal.transport_request_id,
        surface: p.surface,
        coalesced: p.coalesced ? 1 : 0,
        tool_call_id: p.toolCallId ?? null,
        turn_id: p.turnId ?? null,
        hook_session_id: p.sessionId ?? null,
        command: p.command,
        description: p.description,
        command_digest: p.commandDigest ?? p.command_digest ?? null,
        pattern_keys: p.pattern_keys.length ? p.pattern_keys : p.pattern_key ? [p.pattern_key] : [],
        choices: [
          'once',
          ...(p.allow_session === false ? [] : (['session'] as const)),
          ...(p.allow_permanent === false ? [] : (['always'] as const)),
          'deny',
        ],
        ...(p.expiresAt ? { expires_at: p.expiresAt } : {}),
      })
      row = readApprovalRow(sqlite, id)!
      if (row.stage === 'human') claimCompletion(sqlite, signal, row.id, at)
    } else if (!signal.matched_approval_id) {
      // Gate attachment requires an exact request key. Never infer it from tool ids or command text.
      if (row.gate_id && row.gate_id !== signal.gate_id) return false
      patchApproval(
        sqlite,
        row.id,
        {
          producer_id: signal.producer_id,
          producer_incarnation: signal.producer_incarnation,
          gate_id: signal.gate_id,
          tool_call_id: p.toolCallId ?? row.tool_call_id,
          turn_id: p.turnId ?? row.turn_id,
          hook_session_id: p.sessionId ?? row.hook_session_id,
          coalesced: p.coalesced ? 1 : 0,
          ...(signal.request_id && !smart && !transport
            ? {
                request_id: signal.request_id,
                visible: 1,
                target_kind: run ? 'run_request' : 'gateway_request',
              }
            : {}),
        },
        at,
      )
      row = readApprovalRow(sqlite, row.id)!
    }
    linkSignal(sqlite, signal, row, at)
  } else {
    if (!row && !signal.gate_id) {
      if (signal.transport_request_id && signal.producer_incarnation) {
        const value = sqlite
          .prepare(
            'SELECT id FROM approvals WHERE producer_incarnation = ? AND transport_request_id = ? ORDER BY created_at DESC, id DESC LIMIT 2',
          )
          .all(signal.producer_incarnation, signal.transport_request_id)
        if (value.length === 1) row = readApprovalRow(sqlite, IdSchema.parse(value[0]).id)
      } else row = byRequest(sqlite, signal.profile, signal.session_key, signal.request_id)
    }
    if (row && !row.visible && signal.request_id) {
      const requestRow = byRequest(sqlite, signal.profile, signal.session_key, signal.request_id)
      if (requestRow && requestRow.id !== row.id)
        row = foldHidden(sqlite, row, requestRow, at) ?? row
    }
    if (!row) return false
    const choice = ApprovalChoiceSchema.safeParse(p.choice)
    if (p.choice === 'smart_approve' || p.choice === 'smart_deny') {
      if (row.stage !== 'guardian') return false
      patchApproval(
        sqlite,
        row.id,
        {
          guardian_verdict: p.choice === 'smart_deny' ? 'deny' : 'approve',
          decision_choice: p.choice === 'smart_deny' ? 'deny' : 'once',
          decision_by: 'guardian',
          decided_at: signal.at,
        },
        at,
      )
    } else if (choice.success) recordChoice(sqlite, row.id, choice.data, signal.at)
    else if (
      p.kind === 'closed' ||
      ['timeout', 'transport_timeout', 'cancelled', 'notify_failed'].includes(p.choice ?? '') ||
      p.choice?.startsWith('transport_')
    )
      patchApproval(
        sqlite,
        row.id,
        {
          closed_reason: ['timeout', 'transport_timeout'].includes(p.choice ?? '')
            ? 'timeout'
            : (p.choice ?? 'cancelled'),
          closed_at: signal.at,
        },
        at,
      )
  }
  if (!signal.matched_approval_id)
    sqlite
      .prepare('UPDATE approval_signals SET matched_approval_id = ? WHERE id = ?')
      .run(row.id, signal.id)
  return true
}
function replaySignals(sqlite: DatabaseSync, seedIds: string[], at: string): void {
  const queue = [...seedIds]
  const seen = new Set<string>()
  while (queue.length) {
    const row = readApprovalRow(sqlite, queue.shift()!)
    if (!row) continue
    const signature = JSON.stringify([
      row.id,
      row.gate_id,
      row.request_id,
      row.transport_request_id,
      row.guardian_verdict,
    ])
    if (seen.has(signature)) continue
    seen.add(signature)
    const signals = z.array(SignalRowSchema).parse(
      sqlite
        .prepare(
          `SELECT * FROM approval_signals WHERE json_extract(payload, '$.kind') IS NOT NULL AND (
      (matched_approval_id IS NULL AND (
        (producer_incarnation = ? AND gate_id = ?) OR (profile = ? AND session_key = ? AND request_id = ?) OR
        (producer_incarnation = ? AND transport_request_id = ?))) OR
      (producer_incarnation = ? AND (linked_gate_id = ? OR json_extract(payload, '$.supersedesGateId') = ?)))
      ORDER BY producer_incarnation, counter, id`,
        )
        .all(
          row.producer_incarnation,
          row.gate_id,
          row.profile,
          row.session_key,
          row.request_id,
          row.producer_incarnation,
          row.transport_request_id,
          row.producer_incarnation,
          row.gate_id,
          row.gate_id,
        ),
    )
    for (const signal of signals) {
      applySignal(sqlite, signal, at)
      const matched = signal.matched_approval_id
        ? readApprovalRow(sqlite, signal.matched_approval_id)
        : byGate(sqlite, signal.producer_incarnation, signal.gate_id)
      if (matched) queue.push(matched.id)
    }
    queue.push(...touchedApprovalIds(sqlite))
  }
}
export function applyApprovalSignal(
  sqlite: DatabaseSync,
  signalId: number,
  at: string,
  options: ApprovalReadOptions = {},
): DomainEventDraft[] {
  const signal = SignalRowSchema.parse(
    sqlite.prepare('SELECT * FROM approval_signals WHERE id = ?').get(signalId),
  )
  return mutate(sqlite, at, options, () => {
    applySignal(sqlite, signal, at)
    replaySignals(sqlite, touchedApprovalIds(sqlite), at)
  })
}
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
  return mutate(sqlite, at, options, () => {
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
export function completeApprovalTool(
  sqlite: DatabaseSync,
  producer: { id: string; incarnation: string; profile: string },
  completion: { toolCallId: string; counter: number; sessionKey: string | null },
  outcome: 'ok' | 'blocked' | 'error',
  at: string,
  options: ApprovalReadOptions = {},
): DomainEventDraft[] {
  return mutate(sqlite, at, options, () => {
    const value = sqlite
      .prepare(
        `SELECT id FROM approvals WHERE producer_id = ? AND tool_call_id = ? AND stage = 'human' ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(producer.id, completion.toolCallId)
    if (value) {
      patchApproval(sqlite, IdSchema.parse(value).id, { tool_outcome: outcome }, at)
      return
    }
    // The gate may not be ingested yet (a held or redelivered batch). Keep the evidence; payload has no `kind`, so
    // gate replay never selects it. A later gate claims it in producer counter order.
    sqlite
      .prepare(
        `INSERT INTO approval_signals (producer_id, profile, hook, session_key, request_id, payload, at, producer_incarnation, counter)
         VALUES (?, ?, 'post_tool_call', ?, NULL, ?, ?, ?, ?)`,
      )
      .run(
        producer.id,
        producer.profile,
        completion.sessionKey,
        JSON.stringify({ completion: outcome, toolCallId: completion.toolCallId }),
        at,
        producer.incarnation,
        completion.counter,
      )
  })
}
function claimCompletion(sqlite: DatabaseSync, signal: Signal, rowId: string, at: string): void {
  const toolCallId = signal.payload.toolCallId
  if (!toolCallId || !signal.producer_incarnation || signal.counter === null) return
  const value = sqlite
    .prepare(
      `SELECT id, json_extract(payload, '$.completion') AS outcome FROM approval_signals
       WHERE producer_incarnation = ? AND hook = 'post_tool_call' AND matched_approval_id IS NULL
         AND json_extract(payload, '$.toolCallId') = ? AND counter > ?
       ORDER BY counter LIMIT 1`,
    )
    .get(signal.producer_incarnation, toolCallId, signal.counter)
  if (!value) return
  const completion = z
    .object({ id: z.int(), outcome: z.enum(['ok', 'blocked', 'error']) })
    .parse(value)
  patchApproval(sqlite, rowId, { tool_outcome: completion.outcome }, at)
  sqlite
    .prepare('UPDATE approval_signals SET matched_approval_id = ? WHERE id = ?')
    .run(rowId, completion.id)
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
