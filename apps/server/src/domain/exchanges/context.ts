import type { DatabaseSync } from 'node:sqlite'
import { XTC_CAPABILITY_PLACEHOLDER } from '@score/contract'
import { redact, redactBounded } from '../../redact.ts'
import type { MessageRun } from '../message-runs.ts'
import { messageFromRow } from '../rooms.ts'
import { summaryContext } from '../room-summaries.ts'
import { exchangeRow, jobRow } from './store.ts'

// What an agent's turn in an exchanges room is given (docs/briefs/11.0-bold.md §5): a short Score preamble (the job,
// its role in this exchange, how to act, the capability), this job's messages since its last turn in the job, then
// the instruction for this turn. Never other jobs' messages, one-to-ones or older rooms. Frozen once at admission.
// Pins and references (§5 items 3–4) join when 11.2 adds them.

const CONTEXT_BYTES = 8192
const FRESH_TAIL = 10

const speaker = (message: ReturnType<typeof messageFromRow>) =>
  message.author.kind === 'you' ? 'you' : message.author.agentId
const textOf = (message: ReturnType<typeof messageFromRow>) =>
  message.parts
    .filter((part) => part.kind === 'text')
    .map((part) => redact(part.text))
    .join('\n')

function role(sqlite: DatabaseSync, turn: MessageRun): string {
  const exchange = turn.exchange_id ? exchangeRow(sqlite, turn.exchange_id) : null
  const me = turn.agent_id
  if (!exchange) return 'The person asked you directly.'
  const other = exchange.to_agent_id === me ? exchange.from_agent_id : exchange.to_agent_id
  if (exchange.kind === 'review' && exchange.to_agent_id === me)
    return `You are reviewing ${other}'s work (round ${exchange.round}). End with an approval or a send-back.`
  if (exchange.kind === 'review') return `${other} reviewed your work (round ${exchange.round}).`
  if (exchange.kind === 'ask' && exchange.to_agent_id === me)
    return `${other} asked you a question. Your reply is the answer; it goes back to ${other}.`
  if (exchange.kind === 'ask') return `${other} answered your question.`
  return `${other} handed this work to you.`
}

function howToAct(coding: boolean, capability: boolean): string {
  const actions =
    'handoff {to, note} (pass the work on), ask {to, question} (the answer comes back to you), review {to, note} ' +
    '(when you have the work), approve {note} / send_back {note} (when you review), reply {text} (marks your answer)'
  const mention = 'Writing @name only mentions someone; it does not hand anything off.'
  if (coding)
    return [
      `To route the work, end your final reply with exactly one fenced score-action block holding one JSON action: ${actions}.`,
      'Example:\n```score-action\n{"action":"review","to":"reviewer","note":"Ready for a look."}\n```',
      `No block = no action. ${mention}`,
    ].join('\n')
  return [
    `To route the work, call one Score tool before your turn ends: score_handoff, score_ask, score_review, score_approve, score_send_back or score_reply (${actions}). It takes effect when your turn ends, one routing action per turn.`,
    capability
      ? `Pass this capability exactly: ${XTC_CAPABILITY_PLACEHOLDER}. Never write it anywhere else.`
      : '',
    mention,
  ]
    .filter(Boolean)
    .join('\n')
}

/** Newest-first lines kept while they fit, returned oldest first, with a note of how many were left out. */
function fit(lines: string[]): string[] {
  const kept: string[] = []
  let size = 0
  for (const line of lines.toReversed()) {
    const bounded = redactBounded(line, CONTEXT_BYTES)
    if (size + bounded.length > CONTEXT_BYTES && kept.length) break
    kept.unshift(bounded)
    size += bounded.length + 1
  }
  const dropped = lines.length - kept.length
  return dropped ? [`(${dropped} earlier messages left out)`, ...kept] : kept
}

/** The job's messages since this agent's last turn in the job, or a fresh session's view of it. */
function jobMessages(sqlite: DatabaseSync, turn: MessageRun, jobId: string): string[] {
  const last = sqlite
    .prepare(
      `SELECT m.created_at, m.id FROM message_runs mr JOIN messages m ON m.id = mr.message_id
       WHERE mr.job_id = ? AND mr.agent_id = ? AND mr.turn_id != ? AND mr.state = 'completed' AND mr.purpose IS NULL
       ORDER BY m.created_at DESC, m.id DESC LIMIT 1`,
    )
    .get(jobId, turn.agent_id, turn.turn_id) as { created_at: string; id: string } | undefined
  // A turn the person started carries their message as its instruction; a hand-over keeps the other agent's reply.
  const repeated = turn.hop === 0 ? turn.parent_message_id : ''
  const visible = `room_id = ? AND job_id = ? AND deleted_at IS NULL AND streaming = 0 AND id != ?
    AND NOT EXISTS (SELECT 1 FROM json_each(messages.parts) WHERE json_extract(value, '$.kind') = 'summary')`
  if (last)
    return sqlite
      .prepare(
        `SELECT * FROM messages WHERE ${visible} AND (created_at, id) > (?, ?) ORDER BY created_at, id`,
      )
      .all(turn.room_id, jobId, repeated, last.created_at, last.id)
      .map(messageFromRow)
      .map((message) => `${speaker(message)}: ${textOf(message)}`)
  // A fresh session in this job: its summary when there is a usable one, else its first message and the latest ones.
  const summarised = summaryContext(sqlite, turn.room_id, jobId, repeated)
  if (summarised) return [summarised]
  const rows = sqlite
    .prepare(`SELECT * FROM messages WHERE ${visible} ORDER BY created_at, id`)
    .all(turn.room_id, jobId, repeated)
    .map(messageFromRow)
  const picked = rows.length > FRESH_TAIL + 1 ? [rows[0]!, ...rows.slice(-FRESH_TAIL)] : rows
  return picked.map((message) => `${speaker(message)}: ${textOf(message)}`)
}

/**
 * The admission input of a turn in an exchanges room. `capability`: the turn may act through the bridge tools (a
 * Hermes agent), so the input carries the placeholder the dispatcher fills in; coding agents act with a block.
 */
export function jobRunInput(
  sqlite: DatabaseSync,
  turn: MessageRun,
  { coding }: { coding: boolean },
): string {
  const job = turn.job_id ? jobRow(sqlite, turn.job_id) : null
  if (!job) return turn.input
  const exchange = turn.exchange_id ? exchangeRow(sqlite, turn.exchange_id) : null
  const room = sqlite.prepare('SELECT name FROM rooms WHERE id = ?').get(turn.room_id) as {
    name: string
  }
  const preamble = [
    `[Score] You are ${turn.agent_id}, working on the job "${redact(job.title)}" in ${redact(room.name)}.`,
    role(sqlite, turn),
    exchange ? `This exchange has used ${exchange.turns_used} of ${exchange.budget} turns.` : '',
    howToAct(coding, !coding),
  ]
    .filter(Boolean)
    .join('\n')
  const messages = fit(jobMessages(sqlite, turn, job.id))
  return [
    preamble,
    ...(messages.length ? ['', 'In this job since your last turn:', ...messages] : []),
    '',
    turn.input,
  ].join('\n')
}
