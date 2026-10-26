import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import {
  ORCH_LIMITS,
  SubagentSummarySchema,
  type Message,
  type MessagePart,
  type SubagentSummary,
} from '@score/contract'
import { z } from 'zod'
import { HttpError } from '../errors.ts'
import type { DomainEventDraft } from '../hub/ingest.ts'
import { redact, redactBounded } from '../redact.ts'
import { parseMessage } from './parse.ts'
import { decideHandoffs, messageTurnId } from './routing.ts'
import { messageFromRow, storeMessage, updateMessage } from './rooms.ts'
import { parsePlanSteps, planPart } from './plan.ts'
import { sanitizeSummaryText, summaryContext } from './room-summaries.ts'
import { markStaleSummaries, visibleSummaries } from './summary-stale.ts'

export const MessageRunSchema = z.object({
  alternative_of: z.string().nullable().default(null),
  message_id: z.string(),
  run_id: z.string().nullable(),
  room_id: z.string(),
  agent_id: z.string(),
  chain_id: z.string(),
  hop: z.int().nonnegative(),
  turn_id: z.string(),
  parent_message_id: z.string(),
  from_agent_id: z.string().nullable(),
  input: z.string(),
  admission_input: z.string().nullable(),
  model: z.string().nullable(),
  provider: z.string().nullable(),
  agents: z.string().transform((value) => z.array(z.string()).parse(JSON.parse(value))),
  state: z.enum(['pending', 'active', 'completed', 'failed']),
  created_at: z.iso.datetime(),
  pending: z.string(),
  plan_first: z.int().min(0).max(1),
  /** 'summary' = writes the room summary (PLAN 7.4a); null = answers a message. */
  purpose: z.enum(['summary']).nullable().optional(),
  /** Set for the reply of an orchestration lead or step attempt (PLAN 7.5): no hand-offs, no plan, no retry. */
  orchestration_attempt_id: z.string().nullable().optional(),
  /** The job the turn belongs to (PLAN 11.1a); set by the insert trigger from the message it answers. */
  job_id: z.string().nullable().optional(),
  /** The exchange the turn works in (PLAN 11.1b); null for a turn the person started. */
  exchange_id: z.string().nullable().optional(),
  /** The person stopped this turn (PLAN 11.1c): its actions are dropped when it completes. */
  stop_requested_at: z.string().nullable().optional(),
})
export type MessageRun = z.infer<typeof MessageRunSchema>

export function reserveMessageRun(
  sqlite: DatabaseSync,
  req: {
    parentMessageId: string
    roomId: string
    agentId: string
    chainId: string
    hop: number
    input: string
    agents: string[]
    model?: string
    provider?: string
    fromAgentId?: string
    planFirst?: boolean
    /** A retry of an earlier reply (PLAN 5.24): a fresh turn for the same message and agent. */
    retryNonce?: string
    /** A retry repeats exactly what the first attempt was admitted with (the room has moved on since). */
    admissionInput?: string
    /** The run writes the room summary instead of answering (PLAN 7.4a). */
    purpose?: 'summary'
    /** The exchange the turn works in (PLAN 11.1b). */
    exchangeId?: string | null
    /** 2.4.0: the first reply of the group this reply is another version of. */
    alternativeOf?: string
  },
  now: string,
): string {
  assertAgentAdmits(sqlite, req.agentId)
  const turnId = messageTurnId(req.parentMessageId, req.agentId, req.retryNonce)
  sqlite
    .prepare(
      `INSERT INTO message_runs
    (message_id, room_id, agent_id, chain_id, hop, turn_id, parent_message_id, from_agent_id, input, model, provider, agents, created_at, plan_first, admission_input, purpose, exchange_id, alternative_of)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    )
    .run(
      `reply:${turnId}`,
      req.roomId,
      req.agentId,
      req.chainId,
      req.hop,
      turnId,
      req.parentMessageId,
      req.fromAgentId ?? null,
      // The person's instruction is kept verbatim (the adapter strips the gateway key); agent text is redacted by callers.
      req.input,
      req.model ?? null,
      req.provider ?? null,
      JSON.stringify(req.agents),
      now,
      req.planFirst ? 1 : 0,
      req.admissionInput ?? null,
      req.purpose ?? null,
      req.exchangeId ?? null,
      req.alternativeOf ?? null,
    )
  const job = sqlite.prepare('SELECT job_id FROM message_runs WHERE turn_id = ?').get(turnId) as
    { job_id: string | null } | undefined
  if (job?.job_id) ensureJobSession(sqlite, job.job_id, req.agentId, now)
  return `reply:${turnId}`
}

/** What Try another adds to the person's message (once, however often it is asked). */
const ANOTHER_NOTE =
  '\n\n(You already answered this message. The person asked for another answer: give a different reply from your earlier one.)'

/**
 * Retry (PLAN 5.24): the same agent answers the same person's message again. The new turn is queued like any other,
 * so pause holds, approvals, attachments and the one-active-turn-per-agent order behave the same.
 */
export function retryReply(
  sqlite: DatabaseSync,
  roomId: string,
  messageId: string,
  nonce: string,
  now: string,
  /** `another`: Try another; `group: false`: a fresh attempt that is not shown as another version (2.3.0 recovery). */
  options: { another?: boolean; group?: boolean } = {},
): string {
  const found = sqlite
    .prepare('SELECT streaming FROM messages WHERE id = ? AND room_id = ? AND deleted_at IS NULL')
    .get(messageId, roomId)
  if (!found) throw new HttpError(404, 'not_found', 'Couldn’t find that message.')
  const reply = sqlite
    .prepare('SELECT * FROM message_runs WHERE message_id = ? AND room_id = ?')
    .get(messageId, roomId)
  const parsed = reply === undefined ? undefined : MessageRunSchema.parse(reply)
  if (
    !parsed ||
    parsed.hop !== 0 ||
    parsed.from_agent_id !== null ||
    parsed.purpose ||
    parsed.orchestration_attempt_id
  )
    throw new HttpError(409, 'conflict', 'Only a reply to your own message can be retried.')
  if (parsed.state === 'pending' || parsed.state === 'active')
    throw new HttpError(409, 'conflict', 'This reply is still being written.')
  const parent = sqlite
    .prepare(
      "SELECT 1 FROM messages WHERE id = ? AND room_id = ? AND author_kind = 'you' AND deleted_at IS NULL",
    )
    .get(parsed.parent_message_id, roomId)
  if (!parent)
    throw new HttpError(409, 'conflict', 'The message this reply answered no longer exists.')
  const busy = sqlite
    .prepare(
      `SELECT 1 FROM message_runs WHERE parent_message_id = ? AND agent_id = ? AND state IN ('pending', 'active')`,
    )
    .get(parsed.parent_message_id, parsed.agent_id)
  if (busy) throw new HttpError(409, 'conflict', 'This agent is already answering that message.')
  const paused = sqlite
    .prepare(
      `SELECT 1 FROM team_state WHERE paused_at IS NOT NULL
       UNION ALL SELECT 1 FROM agent_pauses WHERE agent_id = ?
       UNION ALL SELECT 1 FROM briefs WHERE id = ? AND paused_at IS NOT NULL`,
    )
    .get(parsed.agent_id, parsed.chain_id)
  if (paused) throw new HttpError(409, 'conflict', 'Resume the work before retrying.')
  // Every version of a reply names the first one, so the room shows them together (2.4.0).
  const first = sqlite
    .prepare('SELECT alternative_of FROM messages WHERE id = ?')
    .get(messageId) as { alternative_of: string | null } | undefined
  const alternativeOf = first?.alternative_of ?? messageId
  return reserveMessageRun(
    sqlite,
    {
      parentMessageId: parsed.parent_message_id,
      roomId,
      agentId: parsed.agent_id,
      chainId: parsed.chain_id,
      hop: 0,
      // Try another (2.4.0): the agent keeps its session (it remembers its earlier answer), is told the person wants a
      // different one, and gets the room as it is now rather than the first attempt's frozen context.
      input: options.another
        ? `${parsed.input.replace(ANOTHER_NOTE, '')}${ANOTHER_NOTE}`
        : parsed.input,
      agents: parsed.agents,
      ...(parsed.model ? { model: parsed.model } : {}),
      ...(parsed.provider ? { provider: parsed.provider } : {}),
      ...(parsed.plan_first ? { planFirst: true } : {}),
      retryNonce: nonce,
      ...(parsed.admission_input !== null && !options.another
        ? { admissionInput: parsed.admission_input }
        : {}),
      ...(options.group === false ? {} : { alternativeOf }),
    },
    now,
  )
}

/** A turn whose reservation was cancelled (state no longer pending) before Hermes admitted its run. */
export function isCancelledTurn(sqlite: DatabaseSync, turnId: string): boolean {
  const row = sqlite
    .prepare('SELECT run_id, state FROM message_runs WHERE turn_id = ?')
    .get(turnId) as { run_id: string | null; state: string } | undefined
  return row !== undefined && row.run_id === null && row.state !== 'pending'
}

export function attachRunMessage(
  sqlite: DatabaseSync,
  turnId: string,
  runId: string,
  now: string,
): DomainEventDraft[] {
  const value = sqlite.prepare('SELECT * FROM message_runs WHERE turn_id = ?').get(turnId)
  if (!value) return []
  const mapping = MessageRunSchema.parse(value)
  if (mapping.run_id !== null) return []
  // Cancelled while Hermes was admitting it: no reply may stream into the room (the caller stops the run).
  if (mapping.state !== 'pending') return []
  sqlite
    .prepare("UPDATE message_runs SET run_id = ?, state = 'active' WHERE turn_id = ?")
    .run(runId, turnId)
  // Every started agent turn in an exchange counts against its budget (brief §4.5).
  const counted: DomainEventDraft[] = []
  if (mapping.exchange_id) {
    sqlite
      .prepare(
        'UPDATE exchanges SET turns_used = turns_used + 1, updated_at = ?, version = version + 1 WHERE id = ?',
      )
      .run(now, mapping.exchange_id)
    counted.push(...exchangeEvent(sqlite, mapping.exchange_id))
  }
  const drafts = counted
  drafts.push(
    ...storeMessage(
      sqlite,
      {
        id: mapping.message_id,
        roomId: mapping.room_id,
        author: { kind: 'agent', agentId: mapping.agent_id },
        to: [],
        parts: [],
        refs: [{ kind: 'run', runId }],
        streaming: true,
        createdAt: now,
        ...(mapping.job_id ? { jobId: mapping.job_id } : {}),
        ...(mapping.alternative_of ? { alternativeOf: mapping.alternative_of } : {}),
      },
      now,
    ),
  )
  if (mapping.from_agent_id)
    drafts.push({
      type: 'handoff.created',
      data: {
        briefId: sqlite.prepare('SELECT id FROM briefs WHERE id = ?').get(mapping.chain_id)
          ? mapping.chain_id
          : null,
        handoff: {
          id: turnId,
          from: { agentId: mapping.from_agent_id, blockId: mapping.parent_message_id },
          to: { agentId: mapping.agent_id, blockId: mapping.message_id },
          kind: 'handoff',
          at: now,
        },
      },
    })
  return drafts
}

// Redaction matches whole patterns, but a run streams text in arbitrary chunks: a token, or a label and its value
// ("Authorization: Bearer" + "eyJ…", "api_key:" + value, a private key over many chunks), can arrive split. Text a
// later chunk could still turn into a secret is held back (not stored in the message, not emitted) until it settles
// or the run completes. The held text is sealed with a per-process key so raw fragments never sit on disk; after a
// restart it can't be opened and is dropped (at worst the last words of an interrupted reply).
const MAX_HELD = 8192
const SECRET_CONTEXT =
  /(?:[=:]|\b(?:authorization|bearer|basic|key|token|secret|password|passwd))["']?\s*$/i
const OPEN_QUOTE = /[=:]\s*(["'])(?:(?!\1)[^\n])*$/
const lineStart = (text: string, index: number) => text.lastIndexOf('\n', index - 1) + 1

/** How much of `text` no later chunk can change: the rest stays held. */
export function settledLength(text: string): number {
  let cut = 0
  for (let index = text.length - 1; index >= 0; index--)
    if (/\s/.test(text[index]!)) {
      cut = index + 1
      break
    }
  // A label that a value may still follow holds its whole line back.
  const from = Math.max(0, cut - 200)
  const context = SECRET_CONTEXT.exec(text.slice(from, cut))
  if (context) cut = Math.min(cut, lineStart(text, from + context.index))
  if (OPEN_QUOTE.test(text.slice(lineStart(text, cut), cut))) cut = lineStart(text, cut)
  // An unterminated PEM block holds everything from its start.
  const begin = text.lastIndexOf('-----BEGIN')
  if (begin !== -1 && !/-----END [A-Z0-9 ]+-----/.test(text.slice(begin)))
    cut = Math.min(cut, lineStart(text, begin))
  return cut
}
/** Held text past the limit: true when it can't be kept back any longer. */
const overflows = (text: string, cut: number) => text.length - cut > MAX_HELD

const SEAL_KEY = randomBytes(32)
function seal(text: string): string {
  if (!text) return ''
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', SEAL_KEY, iv)
  const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')
}
// null: sealed by an earlier process, so it can't be opened.
function unseal(value: string): string | null {
  if (!value) return ''
  try {
    const raw = Buffer.from(value, 'base64')
    const decipher = createDecipheriv('aes-256-gcm', SEAL_KEY, raw.subarray(0, 12))
    decipher.setAuthTag(raw.subarray(12, 28))
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}
// "!" marks a reply whose held text was lost to a restart: later chunks then leave an interior gap that only the
// run's final output can repair. "!" is not base64, so it can't collide with sealed text.
const LOST = '!'
function readPending(value: string): { text: string; lost: boolean } {
  const lost = value.startsWith(LOST)
  const text = unseal(lost ? value.slice(1) : value)
  return { text: text ?? '', lost: lost || text === null }
}
const writePending = (text: string, lost: boolean) => (lost ? LOST : '') + seal(text)

const REPLY_MARK = '\n[reply truncated]'

/**
 * An orchestration attempt's reply is bounded at the ingestion edge (PLAN 7.5): streamed text past the result limit is
 * dropped and flagged once, so a runaway agent cannot grow the room, the events or the run's storage reserve.
 */
function clampReply(sqlite: DatabaseSync, mapping: MessageRun, piece: string): string {
  if (!mapping.orchestration_attempt_id || !piece) return piece
  const row = sqlite.prepare('SELECT parts FROM messages WHERE id = ?').get(mapping.message_id) as
    { parts: string } | undefined
  const current = row
    ? (JSON.parse(row.parts) as { kind: string; text?: string }[])
        .filter((part) => part.kind === 'text')
        .map((part) => part.text ?? '')
        .join('')
    : ''
  if (current.endsWith(REPLY_MARK)) return ''
  const room = ORCH_LIMITS.resultBytes - Buffer.byteLength(current)
  if (room <= 0) return REPLY_MARK
  if (Buffer.byteLength(piece) <= room) return piece
  let kept = ''
  for (const char of piece) {
    if (Buffer.byteLength(kept + char) > room) break
    kept += char
  }
  return kept + REPLY_MARK
}

export function appendRunMessage(
  sqlite: DatabaseSync,
  runId: string,
  append: string,
  now: string,
): DomainEventDraft[] {
  const value = sqlite.prepare('SELECT * FROM message_runs WHERE run_id = ?').get(runId)
  if (!value) return []
  const mapping = MessageRunSchema.parse(value)
  const held = readPending(mapping.pending)
  // The redaction context (a "Bearer " label, a PEM start) went with the lost held text, so a continuation can't be
  // redacted safely: show nothing more until the run's final output arrives and is redacted whole.
  if (held.lost) {
    sqlite
      .prepare('UPDATE message_runs SET pending = ? WHERE message_id = ?')
      .run(writePending('', true), mapping.message_id)
    return []
  }
  const text = held.text + append
  const cut = settledLength(text)
  // Too much unsettled text (an unterminated key block, a label whose value never ends): publishing it would lose the
  // context that marks it secret, and later chunks would follow unredacted. Fail closed: publish the settled part,
  // then nothing more until the run's final output arrives and is redacted whole (the "lost" path).
  if (overflows(text, cut)) {
    sqlite
      .prepare('UPDATE message_runs SET pending = ? WHERE message_id = ?')
      .run(writePending('', true), mapping.message_id)
    return cut > 0
      ? updateMessage(
          sqlite,
          mapping.room_id,
          mapping.message_id,
          clampReply(sqlite, mapping, redact(text.slice(0, cut))),
          now,
        )
      : []
  }
  sqlite
    .prepare('UPDATE message_runs SET pending = ? WHERE message_id = ?')
    .run(writePending(text.slice(cut), held.lost), mapping.message_id)
  const piece = cut > 0 ? clampReply(sqlite, mapping, redact(text.slice(0, cut))) : ''
  return piece ? updateMessage(sqlite, mapping.room_id, mapping.message_id, piece, now) : []
}

function flushHeld(sqlite: DatabaseSync, mapping: MessageRun, now: string): DomainEventDraft[] {
  if (!mapping.pending) return []
  const held = readPending(mapping.pending).text
  sqlite
    .prepare("UPDATE message_runs SET pending = '' WHERE message_id = ?")
    .run(mapping.message_id)
  const piece = held ? clampReply(sqlite, mapping, redact(held)) : ''
  return piece ? updateMessage(sqlite, mapping.room_id, mapping.message_id, piece, now) : []
}

/**
 * A run showed life (reasoning, a tool call, an approval, text): restart its reply's stall clock. Text is announced by
 * `message.delta` already, so only the other moves get a `message.progressed` event.
 */
export function noteRunProgress(
  sqlite: DatabaseSync,
  runId: string,
  at: string,
  { announce }: { announce: boolean },
): DomainEventDraft[] {
  const row = sqlite
    .prepare(
      `SELECT m.id, m.room_id FROM message_runs r JOIN messages m ON m.id = r.message_id
       WHERE r.run_id = ? AND m.streaming = 1`,
    )
    .get(runId) as { id: string; room_id: string } | undefined
  if (!row) return []
  // Only forwards: replayed or out-of-order events never move the clock back. At most one write per 5 s: the browser
  // follows live progress from the stream; the stored value only matters when a page loads.
  const throttle = new Date(Date.parse(at) - 5_000).toISOString()
  const changed = sqlite
    .prepare(
      'UPDATE messages SET progress_at = ? WHERE id = ? AND (progress_at IS NULL OR progress_at < ?)',
    )
    .run(at, row.id, throttle).changes
  return announce && changed
    ? [{ type: 'message.progressed', data: { roomId: row.room_id, messageId: row.id, at } }]
    : []
}

// Surfaces a Score-run approval in the room that started the run. Messages are append-only, so the
// card is its own agent message; the fixed id makes this idempotent per approval.
export function approvalMessage(
  sqlite: DatabaseSync,
  approvalId: string,
  now: string,
): DomainEventDraft[] {
  const value = sqlite
    .prepare(
      `SELECT m.room_id, m.agent_id, m.job_id, a.run_id FROM approvals a
       LEFT JOIN message_runs m ON m.run_id = a.run_id WHERE a.id = ? AND a.origin = 'score-run'`,
    )
    .get(approvalId)
  if (!value) return []
  const row = z
    .object({
      room_id: z.string().nullable(),
      agent_id: z.string().nullable(),
      job_id: z.string().nullable(),
      run_id: z.string().nullable(),
    })
    .parse(value)
  if (!row.room_id || !row.agent_id) return []
  return storeMessage(
    sqlite,
    {
      id: `approval:${approvalId}`,
      roomId: row.room_id,
      author: { kind: 'agent', agentId: row.agent_id },
      to: [],
      parts: [{ kind: 'approval', approvalId }],
      refs: row.run_id ? [{ kind: 'run', runId: row.run_id }] : [],
      streaming: false,
      createdAt: now,
      ...(row.job_id ? { jobId: row.job_id } : {}),
    },
    now,
  )
}

export function toolsSummary(tools: string[]): string | null {
  if (!tools.length) return null
  const commands = tools.filter((tool) => tool === 'terminal').length
  const files = tools.filter((tool) => ['write_file', 'patch', 'edit_file'].includes(tool)).length
  const other = tools.length - commands - files
  const parts = []
  if (commands) parts.push(`Ran ${commands} command${commands === 1 ? '' : 's'}`)
  if (files) parts.push(`${commands ? 'edited' : 'Edited'} ${files} file${files === 1 ? '' : 's'}`)
  if (other) parts.push(`${parts.length ? 'used' : 'Used'} ${other} tool${other === 1 ? '' : 's'}`)
  return parts.join(' and ')
}

const MAX_TOOL_CARDS = 30
const MAX_THINKING_PARTS = 8
const ActivityRowSchema = z.object({
  seq: z.int(),
  tool: z.string().min(1).nullable(),
  text: z.string().nullable(),
  preview: z.string().nullable(),
  status: z.enum(['running', 'ok', 'error']).nullable(),
  result_preview: z.string().nullable(),
  call_id: z.string().nullable(),
  parent_call_id: z.string().nullable(),
  subagent: z.string().nullable(),
})

/** The stored sub-agent summary; anything unreadable is absent (PLAN 8.7). */
export function readSubagent(stored: string | null): SubagentSummary | undefined {
  if (stored === null) return undefined
  try {
    const parsed = SubagentSummarySchema.safeParse(JSON.parse(stored))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

/**
 * The tool calls and reasoning of a run as message parts (PLAN 5.25), in the order Hermes sent them. Stored previews were
 * redacted when they arrived; they are redacted and bounded again here because the parts become the stored message.
 */
export function activityParts(
  sqlite: DatabaseSync,
  runId: string,
): { parts: MessagePart[]; overflow: boolean } {
  const rows = z.array(ActivityRowSchema).parse(
    sqlite
      .prepare(
        `SELECT seq, tool, NULL AS text, preview, status, result_preview, call_id, parent_call_id, subagent FROM tool_calls WHERE run_id = ?1
         UNION ALL SELECT seq, NULL, text, NULL, NULL, NULL, NULL, NULL, NULL FROM run_thinking WHERE run_id = ?1 ORDER BY seq`,
      )
      .all(runId),
  )
  const parts: MessagePart[] = []
  let tools = 0
  let thoughts = 0
  let overflow = false
  for (const row of rows) {
    if (row.tool && row.status) {
      if (tools >= MAX_TOOL_CARDS) {
        overflow = true
        continue
      }
      tools++
      parts.push({
        kind: 'tool',
        tool: row.tool.slice(0, 200),
        args: redactBounded(row.preview ?? '', 400),
        result: row.result_preview === null ? null : redactBounded(row.result_preview, 500),
        status: row.status,
        ...(row.call_id ? { callId: row.call_id.slice(0, 200) } : {}),
        ...(row.parent_call_id ? { parentCallId: row.parent_call_id.slice(0, 200) } : {}),
        ...(readSubagent(row.subagent) ? { subagent: readSubagent(row.subagent)! } : {}),
      })
    } else if (row.text && thoughts < MAX_THINKING_PARTS) {
      thoughts++
      parts.push({ kind: 'thinking', text: redactBounded(row.text, 4096) })
    }
  }
  return { parts, overflow }
}

/**
 * The tool cards and reasoning of a reply that is still being written (PLAN 5.39), as the `message.updated` the browser
 * replaces the message's parts with. They are what completion stores in front of the text, so the card that appears here
 * stays where it is when the reply ends. Nothing is stored now: the final parts are written by `completeRunMessage`.
 */
export function liveActivityDraft(sqlite: DatabaseSync, runId: string): DomainEventDraft[] {
  const value = sqlite.prepare('SELECT * FROM message_runs WHERE run_id = ?').get(runId)
  if (!value) return []
  const mapping = MessageRunSchema.parse(value)
  if (mapping.state !== 'active' || mapping.purpose === 'summary') return []
  const message = messageFromRow(
    sqlite.prepare('SELECT * FROM messages WHERE id = ?').get(mapping.message_id),
  )
  if (!message.streaming) return []
  const { parts } = activityParts(sqlite, runId)
  if (parts.length === 0) return []
  return [
    {
      type: 'message.updated',
      data: {
        roomId: mapping.room_id,
        messageId: message.id,
        parts: [...parts, ...message.parts.filter((part) => part.kind === 'text')],
      },
    },
  ]
}

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
    .prepare('UPDATE messages SET parts = ? WHERE id = ?')
    .run(JSON.stringify(message.parts), message.id)
  sqlite.prepare("UPDATE message_runs SET state = 'completed' WHERE message_id = ?").run(message.id)
  return [
    ...drafts,
    ...updateMessage(sqlite, mapping.room_id, message.id, null, now),
    // Who is busy in the job changed (PLAN 11.2).
    ...(mapping.job_id ? jobEvent(sqlite, mapping.job_id) : []),
  ]
}

/** A turn of a room that routes with exchanges (orchestration attempts never do: their executor routes them). */
function exchangeRoom(sqlite: DatabaseSync, mapping: MessageRun): boolean {
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

export function roomRunInput(
  sqlite: DatabaseSync,
  roomId: string,
  input: string,
  parentMessageId: string,
  jobId?: string | null,
  /** 2.4.0: a version of an earlier reply; the group's other versions stay out of the window (the agent has them). */
  alternativeOf?: string | null,
): string {
  // Only the turn's own job is context (PLAN 11.1b): a room's other threads are not this conversation.
  const job = jobId ?? defaultJobId(sqlite, roomId) ?? ''
  // A usable summary replaces the plain window: "summary + the messages after it" (PLAN 7.4a).
  // Pinned decisions and referenced jobs' frozen summaries (PLAN 11.2) come before the room's own context.
  const cross = crossContext(sqlite, roomId, parentMessageId)
  if (cross) input = `${input}\n\n${cross}`
  const summarised = summaryContext(sqlite, roomId, job, parentMessageId)
  if (summarised) return `${input}\n\nRoom context:\n${summarised}`
  const messages = sqlite
    .prepare(
      `SELECT * FROM messages WHERE room_id = ? AND job_id = ? AND id != ? AND deleted_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM json_each(messages.parts) WHERE json_extract(value, '$.kind') = 'summary')
         AND (? IS NULL OR (id != ? AND COALESCE(alternative_of, '') != ?))
       ORDER BY created_at DESC, id DESC LIMIT 10`,
    )
    .all(
      roomId,
      job,
      parentMessageId,
      alternativeOf ?? null,
      alternativeOf ?? '',
      alternativeOf ?? '',
    )
    .map(messageFromRow)
    .reverse()
  const context = redactBounded(
    messages
      .map(
        (message) =>
          `${message.author.kind === 'you' ? 'you' : message.author.agentId}: ${redact(agentText(message.parts))}`,
      )
      .join('\n'),
    8192,
  )
  return context ? `${input}\n\nRoom context:\n${context}` : input
}

export function failMessageRun(
  sqlite: DatabaseSync,
  turnId: string,
  code: string,
  now: string,
  notice?: string,
): DomainEventDraft[] {
  const value = sqlite.prepare('SELECT * FROM message_runs WHERE turn_id = ?').get(turnId)
  if (!value) return []
  const mapping = MessageRunSchema.parse(value)
  if (mapping.state !== 'pending') return []
  sqlite.prepare("UPDATE message_runs SET state = 'failed' WHERE turn_id = ?").run(turnId)
  // A turn that never started still ends its part in an exchange: whoever waited on it now waits on the person.
  const settled = exchangeRoom(sqlite, mapping)
    ? settleExchangeTurn(
        sqlite,
        mapping,
        mapping.message_id,
        { status: 'failed', reply: '', coding: false },
        now,
      )
    : { drafts: [], notices: [] }
  // The contract has no system part; a short text notice from the agent explains the silence.
  const stored = storeMessage(
    sqlite,
    {
      id: mapping.message_id,
      roomId: mapping.room_id,
      author: { kind: 'agent', agentId: mapping.agent_id },
      to: [],
      parts: [
        { kind: 'text', text: notice ?? `Couldn't start this agent (${code}).` },
        ...settled.notices,
      ],
      createdAt: now,
      streaming: false,
      refs: [],
      ...(mapping.job_id ? { jobId: mapping.job_id } : {}),
      ...(mapping.alternative_of ? { alternativeOf: mapping.alternative_of } : {}),
    },
    now,
  )
  return [...settled.drafts, ...stored]
}
import { agentAdmits, assertAgentAdmits } from './agent-lifecycle.ts'
import { defaultJobId, ensureJobSession } from './job-sessions.ts'
import { exchangeEvent, jobEvent, updateJob } from './exchanges/store.ts'
import { crossContext } from './exchanges/sharing.ts'
import { agentText } from './message-text.ts'
import { jobState, settleExchangeTurn } from './exchanges/apply.ts'
