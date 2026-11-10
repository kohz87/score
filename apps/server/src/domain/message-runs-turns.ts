import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { HttpError } from '../errors.ts'
import type { DomainEventDraft } from '../hub/ingest.ts'
import { assertAgentAdmits } from './agent-lifecycle.ts'
import { exchangeEvent } from './exchanges/store.ts'
import { ensureJobSession } from './job-sessions.ts'
import { messageTurnId } from './routing.ts'
import { storeMessage } from './rooms.ts'

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
  const retried = reserveMessageRun(
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
  // Decision 182: a retry runs on what the first attempt ran on, the agent's own included, not a model chosen since.
  sqlite
    .prepare(
      `UPDATE message_runs SET model_chosen = (SELECT model_chosen FROM message_runs WHERE message_id = ?)
       WHERE message_id = ?`,
    )
    .run(messageId, retried)
  return retried
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
