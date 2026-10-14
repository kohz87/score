import type { OrchEvent, OrchReceipt } from '@score/contract'
import type { DatabaseSync } from 'node:sqlite'
import { redact } from '../../redact.ts'
import { attemptsOf, gatesOf, inquiriesOf, stepsOf, type OrchRow } from './store.ts'

// Event history for the live diagram, the live log and the replay (PLAN 7.5b). Derived on read from rows that are
// written in the same transactions as the changes they describe, so the history is exactly what the engine did.

const clip = (text: string, max = 280): string => {
  const line = redact(text).replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

// Same-millisecond events keep their causal order: a command before the gate it opened, a decision before the
// admission it caused, a result before the lead turn that ends because of it.
const RANK: Record<OrchEvent['kind'], number> = {
  run_started: 0,
  lead_wake: 1,
  command: 2,
  gate_opened: 3,
  inquiry_opened: 3,
  gate_decided: 4,
  inquiry_answered: 4,
  control: 5,
  step_admitted: 6,
  step_state: 7,
  step_result: 8,
  lead_done: 9,
}

const CONTROL_TEXT: Record<string, string> = {
  paused: 'Run paused',
  resumed: 'Run resumed',
  stop_requested: 'Stop requested: nothing new is admitted',
  waiver: 'Continued while a cancelled step may still run',
  abandoned: 'Unresolved attempts abandoned',
  limits_changed: 'Limits changed',
  agent_remapped: 'A replaced agent was accepted for the rest of the run',
  policy_remapped: 'New settings were accepted for a coding agent',
  coding_reach_acknowledged: 'What the coding agents can reach was accepted',
  recovered_text:
    'Hermes forgot a run; its text was recovered from the history but does not prove it ended',
  finish_requested: 'The lead asked to finish',
  ended: 'Run ended',
  late_result: 'A late result arrived and was recorded, not used',
  recovered_unknown: 'After a restart a step run is not confirmed as ended',
}

const CAUSE_TEXT: Record<string, string> = {
  step_blocked: 'blocked',
  step_unknown: 'not confirmed as ended',
  step_abandoned: 'abandoned',
}

export function timelineOf(sqlite: DatabaseSync, o: OrchRow): OrchEvent[] {
  const steps = stepsOf(sqlite, o.id)
  const attempts = attemptsOf(sqlite, o.id)
  const stepById = new Map(steps.map((s) => [s.id, s]))
  const events: OrchEvent[] = []
  const add = (
    event: Partial<OrchEvent> & Pick<OrchEvent, 'id' | 'at' | 'kind' | 'summary'>,
  ): void => {
    events.push({
      stepId: null,
      attemptId: null,
      tool: null,
      verdict: null,
      code: null,
      ...event,
    })
  }

  add({ id: 'run', at: o.created_at, kind: 'run_started', summary: 'Run started' })

  for (const a of attempts) {
    if (a.kind === 'lead') {
      add({
        id: `lead:${a.id}:wake`,
        at: a.sent_at ?? a.created_at,
        kind: 'lead_wake',
        attemptId: a.id,
        summary: `Lead turn ${a.n} started`,
      })
      if (a.terminated_at)
        add({
          id: `lead:${a.id}:done`,
          at: a.terminated_at,
          kind: 'lead_done',
          attemptId: a.id,
          verdict: a.evidence,
          summary: `Lead turn ${a.n} ${a.evidence === 'failed' ? 'failed' : 'ended'}`,
        })
      else if (a.state === 'unknown')
        add({
          id: `lead:${a.id}:unknown`,
          at: a.updated_at,
          kind: 'lead_done',
          attemptId: a.id,
          verdict: 'unknown',
          summary: clip(
            `Lead turn ${a.n} is not confirmed as ended: ${a.unknown_reason ?? 'no evidence'}`,
          ),
        })
      continue
    }
    const stepId = a.step_id
    if (a.sent_at)
      add({
        id: `step:${a.id}:admitted`,
        at: a.sent_at,
        kind: 'step_admitted',
        stepId,
        attemptId: a.id,
        summary: `${stepId} started by ${a.agent_id} (try ${a.n})`,
      })
    if (a.terminated_at) {
      const step = stepId ? stepById.get(stepId) : undefined
      const latest = stepId ? attempts.findLast((x) => x.step_id === stepId) : undefined
      const verdict =
        latest?.id === a.id && step && ['succeeded', 'failed'].includes(step.status)
          ? step.status
          : a.evidence === 'completed'
            ? 'succeeded'
            : 'failed'
      const preview = latest?.id === a.id && step?.result ? `: ${clip(step.result, 160)}` : ''
      add({
        id: `step:${a.id}:result`,
        at: a.terminated_at,
        kind: 'step_result',
        stepId,
        attemptId: a.id,
        verdict,
        summary: `${stepId} ${verdict} (${a.agent_id})${preview}`,
      })
    } else if (a.state === 'unknown')
      add({
        id: `step:${a.id}:unknown`,
        at: a.updated_at,
        kind: 'step_state',
        stepId,
        attemptId: a.id,
        verdict: 'unknown',
        summary: clip(`${stepId} is not confirmed as ended: ${a.unknown_reason ?? 'no evidence'}`),
      })
  }

  const commands = sqlite
    .prepare(
      'SELECT attempt_id, command_id, tool, receipt, created_at FROM orc_commands WHERE orchestration_id = ? ORDER BY created_at, rowid',
    )
    .all(o.id) as {
    attempt_id: string
    command_id: string
    tool: string
    receipt: string
    created_at: string
  }[]
  for (const c of commands) {
    const receipt = JSON.parse(c.receipt) as OrchReceipt
    const result = receipt.result ?? {}
    const stepId = typeof result.stepId === 'string' ? result.stepId : null
    const verdict = receipt.status === 'ok' ? 'accepted' : receipt.status
    const base = {
      id: `cmd:${c.attempt_id}:${c.command_id}`,
      at: c.created_at,
      kind: 'command' as const,
      attemptId: c.attempt_id,
      tool: c.tool,
      verdict,
      code: receipt.code ?? null,
      stepId,
    }
    if (receipt.status !== 'ok') {
      add({
        ...base,
        summary: clip(
          `${c.tool} ${verdict}${receipt.code ? ` (${receipt.code})` : ''}: ${receipt.message ?? ''}`,
        ),
      })
      continue
    }
    let summary = `${c.tool} accepted`
    if (c.tool === 'orch.assign') {
      const step = stepId ? stepById.get(stepId) : undefined
      summary = `Assigned ${stepId} to ${step?.agent_id ?? 'an agent'}: ${clip(step?.instruction ?? '', 120)}`
    } else if (c.tool === 'orch.plan')
      summary = `Plan updated (${String(result.entries ?? 0)} entries)`
    else if (c.tool === 'orch.cancel') summary = `Cancelled ${String(result.stepId ?? '')}`
    else if (c.tool === 'orch.ask') summary = 'The lead asked you a question'
    else if (c.tool === 'orch.requestApproval')
      summary = `The lead asked for your approval of ${String(result.stepId ?? '')}`
    else if (c.tool === 'orch.finish') summary = 'The lead asked to finish the run'
    else if (c.tool === 'orch.note') {
      const row = sqlite
        .prepare('SELECT parts FROM messages WHERE id = ?')
        .get(String(result.messageId ?? '')) as { parts: string } | undefined
      const parts = row ? (JSON.parse(row.parts) as { kind: string; text?: string }[]) : []
      const text = parts.find((p) => p.kind === 'text')?.text
      summary = text ? `Note: ${clip(text)}` : 'The lead posted a note'
    }
    add({
      ...base,
      stepId: stepId ?? (typeof result.stepId === 'string' ? result.stepId : null),
      summary,
    })
  }

  for (const g of gatesOf(sqlite, o.id)) {
    add({
      id: `gate:${g.id}:opened`,
      at: g.created_at,
      kind: 'gate_opened',
      stepId: g.step_id,
      summary: `${g.step_id} waits for your approval`,
    })
    if (g.decided_at)
      add({
        id: `gate:${g.id}:decided`,
        at: g.decided_at,
        kind: 'gate_decided',
        stepId: g.step_id,
        verdict: g.status,
        summary:
          g.status === 'withdrawn'
            ? `Gate for ${g.step_id} withdrawn`
            : `You ${g.status === 'approved' ? 'approved' : 'rejected'} ${g.step_id}`,
      })
  }
  for (const q of inquiriesOf(sqlite, o.id)) {
    add({
      id: `inquiry:${q.id}:opened`,
      at: q.created_at,
      kind: 'inquiry_opened',
      summary: clip(`Question for you: ${q.question}`),
    })
    if (q.answered_at)
      add({
        id: `inquiry:${q.id}:answered`,
        at: q.answered_at,
        kind: 'inquiry_answered',
        verdict: q.status,
        summary: q.status === 'withdrawn' ? 'Question withdrawn' : 'You answered the question',
      })
  }

  const history = sqlite
    .prepare('SELECT id, kind, detail, at FROM orc_history WHERE orchestration_id = ? ORDER BY id')
    .all(o.id) as { id: number; kind: string; detail: string; at: string }[]
  for (const h of history) {
    if (!(h.kind in CONTROL_TEXT)) continue
    let text = CONTROL_TEXT[h.kind]!
    if (h.kind === 'ended') {
      const detail = JSON.parse(h.detail) as { status?: string; reason?: string }
      text = `Run ended: ${detail.status ?? ''}${detail.reason ? ` (${detail.reason})` : ''}`
    } else if (h.kind === 'paused') {
      const detail = JSON.parse(h.detail) as { by?: string; reason?: string }
      text = `Run paused${detail.by ? ' by you' : detail.reason ? ` (${detail.reason})` : ''}`
    }
    add({ id: `hist:${h.id}`, at: h.at, kind: 'control', verdict: h.kind, summary: clip(text) })
  }
  const causes = sqlite
    .prepare(
      'SELECT id, kind, ref, detail, at FROM orc_causes WHERE orchestration_id = ? ORDER BY id',
    )
    .all(o.id) as {
    id: number
    kind: string
    ref: string | null
    detail: string | null
    at: string
  }[]
  for (const c of causes) {
    const label = CAUSE_TEXT[c.kind]
    if (!label) continue
    add({
      id: `cause:${c.id}`,
      at: c.at,
      kind: 'step_state',
      stepId: c.ref,
      verdict: label === 'blocked' ? 'blocked' : label === 'abandoned' ? 'abandoned' : 'unknown',
      summary: clip(`${c.ref} ${label}${c.detail ? `: ${c.detail}` : ''}`),
    })
  }

  return events
    .map((event, index) => ({ event, index }))
    .sort(
      (a, b) =>
        a.event.at.localeCompare(b.event.at) ||
        RANK[a.event.kind] - RANK[b.event.kind] ||
        a.index - b.index,
    )
    .map(({ event }) => event)
}
