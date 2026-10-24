import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import {
  AutoSummarySchema,
  DEFAULT_AUTO_SUMMARY,
  type AutoSummary,
  type Message,
} from '@score/contract'
import { HttpError } from '../errors.ts'
import { redact, redactBounded } from '../redact.ts'
import { assertAgentAdmits } from './agent-lifecycle.ts'
import { defaultJobId } from './job-sessions.ts'
import { reserveMessageRun } from './message-runs.ts'
import { rewindingRooms } from './room-rewinding.ts'
import { messageFromRow, roomRow } from './rooms.ts'
import { coveredMessageHidden, visibleSummaries, type SummaryPart } from './summary-stale.ts'

/** The fixed instruction of the summary run; the fake adapter recognises its first words. */
export const SUMMARY_INSTRUCTION =
  'Summarise the earlier messages of this room below so the team can continue without them. Keep decisions, open questions, instructions from the person, names, file paths and task ids. Write plain text or Markdown without HTML. Reply with the summary only.'

const MAX_SUMMARY_INPUT_CHARS = 96 * 1024
/** Messages after a summary that are sent along with it, and their budget. */
const MAX_TAIL_MESSAGES = 40
const MAX_TAIL_CHARS = 16384

export function autoSummaryOf(value: string | null): AutoSummary {
  if (value === null) return DEFAULT_AUTO_SUMMARY
  const parsed = AutoSummarySchema.safeParse(JSON.parse(value))
  return parsed.success ? parsed.data : DEFAULT_AUTO_SUMMARY
}

/** Markdown without raw HTML: tags and comments are dropped, so nothing can hide in the text. */
export function sanitizeSummaryText(text: string): string {
  return redactBounded(
    text
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<\/?[a-zA-Z][^>]*>/g, '')
      .trim(),
    16384,
  )
}

const textOf = (message: Message) =>
  message.parts
    .filter((part) => part.kind === 'text')
    .map((part) => part.text)
    .join('\n')
const isSummary = (message: Message) => message.parts.some((part) => part.kind === 'summary')
const line = (message: Message) =>
  `${message.author.kind === 'you' ? 'you' : message.author.agentId}: ${redact(textOf(message))}`

/** Visible, finished messages with no summary part, oldest first, after `after` ((created_at, id)) when given. */
function transcript(
  sqlite: DatabaseSync,
  roomId: string,
  jobId: string,
  after: { createdAt: string; id: string } | null,
  excludeId?: string,
): Message[] {
  const rows = after
    ? sqlite
        .prepare(
          `SELECT * FROM messages WHERE room_id = ? AND job_id = ? AND deleted_at IS NULL AND id != ?
             AND (created_at, id) > (?, ?)
           ORDER BY created_at, id`,
        )
        .all(roomId, jobId, excludeId ?? '', after.createdAt, after.id)
    : sqlite
        .prepare(
          'SELECT * FROM messages WHERE room_id = ? AND job_id = ? AND deleted_at IS NULL AND id != ? ORDER BY created_at, id',
        )
        .all(roomId, jobId, excludeId ?? '')
  return rows.map(messageFromRow).filter((message) => !isSummary(message))
}

export interface UsableSummary {
  messageId: string
  authorAgentId: string | null
  part: SummaryPart
  boundary: { createdAt: string; id: string }
}

/** The job a summary call is about: the given one, else the room's default job (PLAN 11.1b). */
function jobFor(sqlite: DatabaseSync, roomId: string, jobId: string | undefined): string {
  const id = jobId ?? defaultJobId(sqlite, roomId)
  if (!id) throw new HttpError(404, 'not_found', 'Couldn’t find that room.')
  return id
}

/** The newest visible summary that may still be used as context (not stale, and nothing it covers was hidden). */
export function usableSummary(
  sqlite: DatabaseSync,
  roomId: string,
  jobId?: string,
): UsableSummary | null {
  const newest = visibleSummaries(sqlite, roomId, jobFor(sqlite, roomId, jobId))[0]
  if (!newest || newest.part.stale || coveredMessageHidden(sqlite, roomId, newest)) return null
  const boundary = sqlite
    .prepare('SELECT created_at, id FROM messages WHERE id = ? AND room_id = ?')
    .get(newest.part.coversUntil, roomId) as { created_at: string; id: string } | undefined
  if (!boundary) return null
  return {
    messageId: newest.id,
    authorAgentId: newest.authorAgentId,
    part: newest.part,
    boundary: { createdAt: boundary.created_at, id: boundary.id },
  }
}

/**
 * "Summary + the messages after it" as the room context of a turn (PLAN 7.4a), or null when the room has no usable
 * summary and the plain recent window applies.
 */
export function summaryContext(
  sqlite: DatabaseSync,
  roomId: string,
  jobId: string,
  excludeId: string,
): string | null {
  const summary = usableSummary(sqlite, roomId, jobId)
  if (!summary) return null
  const after = transcript(sqlite, roomId, jobId, summary.boundary, excludeId).slice(
    -MAX_TAIL_MESSAGES,
  )
  const lines: string[] = []
  let size = 0
  for (const message of after.toReversed()) {
    const text = redactBounded(line(message), MAX_TAIL_CHARS)
    if (size + text.length > MAX_TAIL_CHARS && lines.length) break
    lines.unshift(text)
    size += text.length + 1
  }
  const author = summary.authorAgentId ?? 'an agent'
  return [
    `Summary of earlier messages (written by ${author}${summary.part.edited ? ', edited by you' : ''}):`,
    redact(summary.part.text),
    ...(lines.length ? ['', 'Messages after the summary:', ...lines] : []),
  ].join('\n')
}

/** Estimated tokens (characters / 4) of the room's visible text that no usable summary covers. */
export function uncoveredTokens(sqlite: DatabaseSync, roomId: string, jobId?: string): number {
  const job = jobFor(sqlite, roomId, jobId)
  const summary = usableSummary(sqlite, roomId, job)
  const chars = transcript(sqlite, roomId, job, summary?.boundary ?? null).reduce(
    (sum, message) => sum + textOf(message).length,
    0,
  )
  return Math.ceil(chars / 4)
}

function summaryRunOpen(sqlite: DatabaseSync, roomId: string, jobId: string): boolean {
  return Boolean(
    sqlite
      .prepare(
        "SELECT 1 FROM message_runs WHERE room_id = ? AND job_id = ? AND purpose = 'summary' AND state IN ('pending', 'active')",
      )
      .get(roomId, jobId),
  )
}

function whyHeld(sqlite: DatabaseSync, roomId: string, leadAgentId: string): string | null {
  if (rewindingRooms.has(roomId)) return 'This room is being rewound. Try again in a moment.'
  if (sqlite.prepare('SELECT 1 FROM team_state WHERE paused_at IS NOT NULL').get())
    return 'The team is paused. Resume it first.'
  if (sqlite.prepare('SELECT 1 FROM agent_pauses WHERE agent_id = ?').get(leadAgentId))
    return `${leadAgentId} is paused. Resume it first.`
  return null
}

/** Reserves the summary run of a job through the room's lead agent. Returns the reply message id. */
export function requestSummary(
  sqlite: DatabaseSync,
  roomId: string,
  now: string,
  jobId?: string,
): string {
  const room = roomRow(sqlite, roomId)
  const job = jobFor(sqlite, roomId, jobId)
  const lead = room.lead_agent_id
  if (!lead) throw new HttpError(409, 'conflict', 'This room has no lead agent to write a summary.')
  const held = whyHeld(sqlite, roomId, lead)
  if (held) throw new HttpError(409, 'conflict', held)
  if (summaryRunOpen(sqlite, roomId, job))
    throw new HttpError(409, 'conflict', 'A summary is already being written.')
  assertAgentAdmits(sqlite, lead)
  const previous = usableSummary(sqlite, roomId, job)
  const messages = transcript(sqlite, roomId, job, previous?.boundary ?? null)
  // Only what is finished: stop before the first message still being written.
  const firstOpen = messages.findIndex((message) => message.streaming)
  const covered = firstOpen === -1 ? messages : messages.slice(0, firstOpen)
  const last = covered.at(-1)
  if (!last) throw new HttpError(409, 'conflict', 'There is nothing new to summarise.')
  const lines: string[] = []
  let size = 0
  for (const message of covered.toReversed()) {
    const text = redactBounded(line(message), 8192)
    if (size + text.length > MAX_SUMMARY_INPUT_CHARS && lines.length) break
    lines.unshift(text)
    size += text.length + 1
  }
  const input = [
    SUMMARY_INSTRUCTION,
    '',
    ...(previous ? ['Summary so far:', redact(previous.part.text), '', 'Newer messages:'] : []),
    ...lines,
  ].join('\n')
  // chain_id must name a message; a brief's root would make the summary run part of that brief's work and status.
  const chain = sqlite
    .prepare(
      'SELECT id FROM messages WHERE room_id = ? AND job_id = ? AND id NOT IN (SELECT id FROM briefs) ORDER BY created_at DESC, id DESC LIMIT 1',
    )
    .get(roomId, job) as { id: string } | undefined
  return reserveMessageRun(
    sqlite,
    {
      parentMessageId: last.id,
      roomId,
      agentId: lead,
      chainId: chain?.id ?? last.id,
      hop: 0,
      input: 'Summarise earlier messages',
      agents: [lead],
      retryNonce: randomUUID(),
      admissionInput: input,
      purpose: 'summary',
    },
    now,
  )
}

/** After a message completed: should this room be summarised now? (cheap read; `requestSummary` re-checks) */
export function shouldAutoSummarise(sqlite: DatabaseSync, roomId: string, jobId?: string): boolean {
  const row = sqlite
    .prepare('SELECT auto_summary, lead_agent_id FROM rooms WHERE id = ?')
    .get(roomId) as { auto_summary: string | null; lead_agent_id: string | null } | undefined
  if (!row?.lead_agent_id) return false
  const setting = autoSummaryOf(row.auto_summary)
  if (!setting.enabled) return false
  const job = jobFor(sqlite, roomId, jobId)
  if (whyHeld(sqlite, roomId, row.lead_agent_id) || summaryRunOpen(sqlite, roomId, job))
    return false
  // A failed attempt is not repeated until the person writes again, so a broken lead does not loop.
  const failed = sqlite
    .prepare(
      "SELECT created_at FROM message_runs WHERE room_id = ? AND job_id = ? AND purpose = 'summary' AND state = 'failed' ORDER BY created_at DESC LIMIT 1",
    )
    .get(roomId, job) as { created_at: string } | undefined
  if (
    failed &&
    !sqlite
      .prepare(
        "SELECT 1 FROM messages WHERE room_id = ? AND job_id = ? AND author_kind = 'you' AND deleted_at IS NULL AND created_at > ?",
      )
      .get(roomId, job, failed.created_at)
  )
    return false
  return uncoveredTokens(sqlite, roomId, job) > setting.thresholdTokens
}
