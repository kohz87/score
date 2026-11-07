import type { DatabaseSync } from 'node:sqlite'
import type { Message, MessagePart } from '@score/contract'
import { z } from 'zod'
import type { DomainEventDraft } from '../hub/ingest.ts'
import { redact, redactBounded } from '../redact.ts'
import { agentAdmits } from './agent-lifecycle.ts'
import { jobState, settleExchangeTurn } from './exchanges/apply.ts'
import { jobEvent, updateJob } from './exchanges/store.ts'
import { activityParts, toolsSummary } from './message-runs-cards.ts'
import { clampReply, flushHeld, readPending } from './message-runs-stream.ts'
import { MessageRunSchema, reserveMessageRun, type MessageRun } from './message-runs-turns.ts'
import { parseMessage } from './parse.ts'
import { parsePlanSteps, planPart } from './plan.ts'
import { messageFromRow, updateMessage } from './rooms.ts'
import { sanitizeSummaryText } from './room-summaries.ts'
import { decideHandoffs } from './routing.ts'
import { runSpeedJson } from './run-speed.ts'
import { markStaleSummaries, visibleSummaries } from './summary-stale.ts'

function failureNotice(
  status: string,
  error: string | null | undefined,
  exitReason?: string | null,
): string {
  // Hermes 0.22.5 ends a turn that used up its tool-call budget with a summary and this reason (decision 128): not a
  // failure, the work just isn't finished.
  const steps = /^max_iterations_reached\((\d+)\/(\d+)\)$/.exec(exitReason ?? '')
  if (steps)
    return `I ran out of steps for this turn (${steps[2]} tool calls) before finishing. Send “continue” to keep going.`
  const detail = error ? `: ${redactBounded(error, 300)}` : ''
  if (status === 'cancelled') return 'This run was stopped.'
  if (status === 'interrupted') return `This run was interrupted${detail}`
  return `This run failed${detail}`
}

export function completeRunMessage(
  sqlite: DatabaseSync,
  runId: string,
  now: string,
  {
    output,
    handoffs: wantHandoffs = true,
    status = 'completed',
    error,
    reply,
    exitReason,
  }: {
    output?: string | null
    handoffs?: boolean
    status?: string
    error?: string | null
    /** Hermes' `turn_exit_reason` on a run that did not complete. */
    exitReason?: string | null
    /**
     * The eligible authoritative reply (7.7a v3 §5): when given, plans and hand-offs read only this text, never the
     * rest of what was streamed (commentary, earlier messages). `null` = there is none, so nothing is parsed.
     */
    reply?: string | null
  } = {},
): DomainEventDraft[] {
  const value = sqlite.prepare('SELECT * FROM message_runs WHERE run_id = ?').get(runId)
  if (!value) return []
  const mapping = MessageRunSchema.parse(value)
  if (mapping.state !== 'active') return []
  // An orchestration attempt's reply is data for the executor: never a hand-off, never a plan (PLAN 7.5).
  const handoffs = wantHandoffs && !mapping.orchestration_attempt_id
  // Nothing can extend the held text any more.
  const lostHeld = readPending(mapping.pending).lost
  const drafts: DomainEventDraft[] = flushHeld(sqlite, mapping, now)
  const message = messageFromRow(
    sqlite.prepare('SELECT * FROM messages WHERE id = ?').get(mapping.message_id),
  )
  // Polling/recovery may only have the final output. Never duplicate text already streamed, but when streaming stopped
  // short (a restart, a lost replay) and the final output continues what was streamed, append the rest: plan parsing and
  // hand-offs below must see the whole reply ("… @reviewer please check" can come after the cut; audit 2026-10-08).
  if (output) {
    const text = redactBounded(output, 8192)
    const streamed = message.parts
      .filter((part) => part.kind === 'text')
      .map((part) => part.text)
      .join('')
    // Held text lost to a restart leaves an interior gap, so the streamed text is no prefix of the output: the
    // authoritative output then replaces it (hand-offs after the gap would otherwise be missed). Without a
    // known loss a differing output is just a different summary and the streamed text stays.
    if (lostHeld && streamed && !text.startsWith(streamed) && !streamed.startsWith(text))
      message.parts = [
        { kind: 'text', text },
        ...message.parts.filter((part) => part.kind !== 'text'),
      ]
    const rest = clampReply(
      sqlite,
      mapping,
      !streamed ? text : text.startsWith(streamed) ? text.slice(streamed.length) : '',
    )
    if (rest) {
      drafts.push(...updateMessage(sqlite, mapping.room_id, message.id, rest, now))
      const last = message.parts.findLast((part) => part.kind === 'text')
      if (last?.kind === 'text') last.text += rest
      else message.parts.push({ kind: 'text', text: rest })
    }
  }
  // Each chunk was redacted as it settled; redact the whole text once more in case a pattern spans chunks.
  message.parts = message.parts.map((part) =>
    part.kind === 'text' ? { ...part, text: redact(part.text) } : part,
  )
  // A run that did not complete would otherwise end as an empty or truncated bubble with no explanation.
  if (status !== 'completed')
    message.parts.push({ kind: 'text', text: failureNotice(status, error, exitReason) })
  if (mapping.purpose === 'summary')
    return [...drafts, ...finishSummaryRun(sqlite, mapping, message, status, now)]
  const tools = z
    .array(z.object({ tool: z.string() }))
    .parse(sqlite.prepare('SELECT tool FROM tool_calls WHERE run_id = ? ORDER BY seq').all(runId))
  const activity = activityParts(sqlite, runId)
  message.parts = [...activity.parts, ...message.parts]
  // Past the card limit (or with no card at all) the compact summary stays, as it is for messages from before 5.25.
  const summary = toolsSummary(tools.map(({ tool }) => tool))
  if (summary && (activity.overflow || !activity.parts.some((part) => part.kind === 'tool')))
    message.parts.push({ kind: 'tools', summary, runId })
  // A plan-first turn only proposes: the checklist becomes a plan part, and nothing is handed off until the
  // person presses Start plan.
  if (mapping.plan_first && !mapping.orchestration_attempt_id) {
    const text =
      reply !== undefined
        ? redact(reply ?? '')
        : message.parts
            .filter((part) => part.kind === 'text')
            .map((part) => part.text)
            .join('\n')
    const plan = planPart(mapping.chain_id, parsePlanSteps(text, mapping.agents), now)
    if (plan) message.parts.push(plan)
    // In an exchanges room the planner's turn acted on nothing (it never gets a capability, so there is no xtc_hash
    // to clear here), and the job stops showing it as working.
    if (exchangeRoom(sqlite, mapping) && mapping.job_id)
      drafts.push(
        ...updateJob(
          sqlite,
          mapping.job_id,
          { state: jobState(sqlite, mapping.job_id, mapping.turn_id) },
          now,
        ),
      )
  } else if (exchangeRoom(sqlite, mapping)) {
    // Agent actions route the work here; a prose @mention hands nothing off (PLAN 11.1b).
    const text =
      reply !== undefined
        ? redact(reply ?? '')
        : message.parts
            .filter((part) => part.kind === 'text')
            .map((part) => redact(part.text))
            .join('\n')
    const settled = settleExchangeTurn(
      sqlite,
      mapping,
      message.id,
      { status, reply: text, coding: codingRun(sqlite, runId) },
      now,
    )
    message.parts.push(...settled.notices)
    drafts.push(...settled.drafts)
  } else if (handoffs) {
    const text =
      reply !== undefined
        ? redact(reply ?? '')
        : message.parts
            .filter((part) => part.kind === 'text')
            .map((part) => redact(part.text))
            .join('\n')
    const edges = z
      .array(z.object({ from: z.string(), to: z.string() }))
      .parse(
        sqlite
          .prepare(
            'SELECT from_agent_id AS "from", agent_id AS "to" FROM message_runs WHERE chain_id = ? AND hop > 0',
          )
          .all(mapping.chain_id),
      )
    const decision = decideHandoffs({
      from: mapping.agent_id,
      mentions: parseMessage(text, mapping.agents).mentions,
      hop: mapping.hop,
      edges,
    })
    // The contract currently has no system message part; keep the visible notice as text.
    if (decision.stopped) message.parts.push({ kind: 'text', text: 'Hand-off limit reached' })
    for (const agentId of decision.targets.filter((id) => agentAdmits(sqlite, id)))
      reserveMessageRun(
        sqlite,
        {
          parentMessageId: message.id,
          roomId: mapping.room_id,
          agentId,
          chainId: mapping.chain_id,
          hop: mapping.hop + 1,
          input: text,
          agents: mapping.agents,
          fromAgentId: mapping.agent_id,
        },
        now,
      )
  }
  sqlite
    .prepare('UPDATE messages SET parts = ?, speed = ? WHERE id = ?')
    .run(
      JSON.stringify(message.parts),
      status === 'completed' ? runSpeedJson(sqlite, runId) : null,
      message.id,
    )
  sqlite.prepare("UPDATE message_runs SET state = 'completed' WHERE message_id = ?").run(message.id)
  return [
    ...drafts,
    ...updateMessage(sqlite, mapping.room_id, message.id, null, now),
    // Who is busy in the job changed (PLAN 11.2).
    ...(mapping.job_id ? jobEvent(sqlite, mapping.job_id) : []),
  ]
}

/** A turn of a room that routes with exchanges (orchestration attempts never do: their executor routes them). */
export function exchangeRoom(sqlite: DatabaseSync, mapping: MessageRun): boolean {
  if (mapping.orchestration_attempt_id) return false
  const row = sqlite.prepare('SELECT routing FROM rooms WHERE id = ?').get(mapping.room_id) as
    { routing: string } | undefined
  return row?.routing === 'exchanges'
}

/** A coding agent's run: it routes with one `score-action` block instead of tools. */
function codingRun(sqlite: DatabaseSync, runId: string): boolean {
  const row = sqlite.prepare('SELECT runtime FROM runs WHERE id = ?').get(runId) as
    { runtime: string } | undefined
  return row !== undefined && row.runtime !== 'hermes'
}

/**
 * The summary run's reply becomes a `summary` part: text only, no tool cards, no hand-offs, no plan. An older summary
 * of the room is replaced by it. A run that failed or came back empty leaves a short text notice instead.
 */
function finishSummaryRun(
  sqlite: DatabaseSync,
  mapping: MessageRun,
  message: Message,
  status: string,
  now: string,
): DomainEventDraft[] {
  const text = sanitizeSummaryText(
    message.parts
      .filter((part) => part.kind === 'text')
      .map((part) => part.text)
      .join('\n'),
  )
  const ok = status === 'completed' && text.length > 0
  const parts: MessagePart[] = ok
    ? [{ kind: 'summary', coversUntil: mapping.parent_message_id, text }]
    : [
        {
          kind: 'text',
          text:
            status === 'completed'
              ? 'The summary came back empty.'
              : `The summary was not written. ${failureNotice(status, null)}`,
        },
      ]
  sqlite
    .prepare('UPDATE messages SET parts = ? WHERE id = ?')
    .run(JSON.stringify(parts), message.id)
  sqlite
    .prepare('UPDATE message_runs SET state = ? WHERE message_id = ?')
    .run(ok ? 'completed' : 'failed', message.id)
  const drafts: DomainEventDraft[] = []
  if (ok) {
    for (const older of visibleSummaries(sqlite, mapping.room_id, mapping.job_id ?? undefined)) {
      if (older.id === message.id) continue
      sqlite
        .prepare(
          'UPDATE messages SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ?',
        )
        .run(now, now, older.id)
      drafts.push({
        type: 'message.deleted',
        data: { roomId: mapping.room_id, messageId: older.id },
      })
    }
  }
  return [
    ...drafts,
    ...updateMessage(sqlite, mapping.room_id, message.id, null, now),
    ...markStaleSummaries(sqlite, mapping.room_id, now),
    ...(mapping.job_id ? jobEvent(sqlite, mapping.job_id) : []),
  ]
}
