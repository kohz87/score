import { ApprovalChoiceSchema } from '@score/contract'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import type { DomainEventDraft } from '../hub/ingest.ts'
import {
  patchApproval,
  readApprovalRow,
  touchedApprovalIds,
  type ApprovalReadOptions,
  type ApprovalRow,
} from './approval-store.ts'
import { IdSchema, SignalRowSchema, type Signal } from './approval-schemas.ts'
import { insertApproval, mutate, recordChoice } from './approval-writes.ts'

export function byGate(
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
export function byRequest(
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
    if (row.stage === 'human') claimCompletion(sqlite, signal, row.id, at)
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
export function replaySignals(sqlite: DatabaseSync, seedIds: string[], at: string): void {
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
export function completeApprovalTool(
  sqlite: DatabaseSync,
  producer: { id: string; incarnation: string; profile: string },
  completion: { gateIds: string[]; counter: number; sessionKey: string | null },
  outcome: 'ok' | 'blocked' | 'error',
  at: string,
  options: ApprovalReadOptions = {},
): DomainEventDraft[] {
  if (!completion.gateIds.length) return []
  return mutate(sqlite, at, options, () => {
    for (const gateId of completion.gateIds) {
      const value = sqlite
        .prepare(
          `SELECT id FROM approvals WHERE producer_incarnation = ? AND gate_id = ? AND stage = 'human'`,
        )
        .get(producer.incarnation, gateId)
      if (value) {
        patchApproval(sqlite, IdSchema.parse(value).id, { tool_outcome: outcome }, at)
        continue
      }
      sqlite
        .prepare(
          `INSERT INTO approval_signals (producer_id, profile, hook, session_key, request_id, payload, at, producer_incarnation, counter, gate_id)
         VALUES (?, ?, 'post_tool_call', ?, NULL, ?, ?, ?, ?, ?)`,
        )
        .run(
          producer.id,
          producer.profile,
          completion.sessionKey,
          JSON.stringify({ completion: outcome }),
          at,
          producer.incarnation,
          completion.counter,
          gateId,
        )
    }
  })
}
function claimCompletion(sqlite: DatabaseSync, signal: Signal, rowId: string, at: string): void {
  if (!signal.gate_id || !signal.producer_incarnation) return
  const value = sqlite
    .prepare(
      `SELECT id, json_extract(payload, '$.completion') AS outcome FROM approval_signals
     WHERE producer_incarnation = ? AND gate_id = ? AND hook = 'post_tool_call'
       AND matched_approval_id IS NULL ORDER BY counter LIMIT 1`,
    )
    .get(signal.producer_incarnation, signal.gate_id)
  if (!value) return
  const completion = z
    .object({ id: z.int(), outcome: z.enum(['ok', 'blocked', 'error']) })
    .parse(value)
  patchApproval(sqlite, rowId, { tool_outcome: completion.outcome }, at)
  sqlite
    .prepare('UPDATE approval_signals SET matched_approval_id = ? WHERE id = ?')
    .run(rowId, completion.id)
}
