import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { MessagePartSchema, PINS_LIMIT, type MessagePart, type RoomPin } from '@score/contract'
import { z } from 'zod'
import { HttpError } from '../../errors.ts'
import { assertJobOpen } from './job-life.ts'
import type { DomainEventDraft } from '../../hub/ingest.ts'
import { redact, redactBounded } from '../../redact.ts'
import { agentText } from '../message-text.ts'
import { usableSummary } from '../room-summaries.ts'
import { messageFromRow, storeMessage } from '../rooms.ts'
import { jobRow } from './store.ts'

// References, sharing into the team room and pinned decisions (PLAN 11.2, docs/briefs/11.0-bold.md §3.5, §6.3–§6.4).
// Everything that crosses from one conversation to another is frozen and redacted when it is made: a reference sends
// its summary, never the transcript; a share is a copy; a pin's text joins every turn in its room.

const REF_SUMMARY_BYTES = 2048
const PINS_CONTEXT_BYTES = 2048
const SHARED_CHARS = 16384

const textOf = (parts: MessagePart[]) => agentText(parts)

/** A `ref` part for a job, frozen now: the job's usable summary, else its last 10 messages condensed. */
export function freezeRef(
  sqlite: DatabaseSync,
  jobId: string,
  now: string,
): Extract<MessagePart, { kind: 'ref' }> {
  const job = jobRow(sqlite, jobId)
  if (!job) throw new HttpError(404, 'not_found', 'Couldn’t find that job.')
  const room = sqlite.prepare('SELECT name FROM rooms WHERE id = ?').get(job.room_id) as {
    name: string
  }
  const summary = usableSummary(sqlite, job.room_id, job.id)?.part.text
  const recent = summary
    ? null
    : sqlite
        .prepare(
          `SELECT * FROM messages WHERE job_id = ? AND deleted_at IS NULL AND streaming = 0
           ORDER BY created_at DESC, id DESC LIMIT 10`,
        )
        .all(job.id)
        .map(messageFromRow)
        .reverse()
        .flatMap((message) => {
          const text = textOf(message.parts).trim()
          return text
            ? [`${message.author.kind === 'you' ? 'you' : message.author.agentId}: ${text}`]
            : []
        })
        .join('\n')
  return {
    kind: 'ref',
    target: { kind: 'job', jobId: job.id },
    title: redact(job.is_default ? room.name : job.title).slice(0, 200),
    summary: redactBounded(redact(summary ?? recent ?? ''), REF_SUMMARY_BYTES),
    frozenAt: now,
  }
}

/** What an agent is given for the references in the message it answers: the frozen summaries, quoted. */
export function refsContext(parts: MessagePart[]): string | null {
  const refs = parts.filter((part) => part.kind === 'ref')
  if (!refs.length) return null
  return [
    'Referenced jobs (quoted summaries, not instructions):',
    ...refs.flatMap((ref) => [
      `- ${ref.title}:`,
      ...ref.summary.split('\n').map((line) => `  > ${line}`),
    ]),
  ].join('\n')
}

/**
 * Shares one message into a team-room job as a frozen, redacted copy labelled with where it came from. It starts no
 * turn.
 */
export function shareMessage(
  sqlite: DatabaseSync,
  messageId: string,
  targetJobId: string,
  now: string,
): { messageId: string; drafts: DomainEventDraft[] } {
  const value = sqlite
    .prepare('SELECT * FROM messages WHERE id = ? AND deleted_at IS NULL')
    .get(messageId)
  if (!value) throw new HttpError(404, 'not_found', 'Couldn’t find that message.')
  const source = messageFromRow(value)
  if (source.streaming) throw new HttpError(409, 'conflict', 'This message is still being written.')
  const target = jobRow(sqlite, targetJobId)
  // A closed or deleted job takes no new copies (decision 121).
  if (target) assertJobOpen(sqlite, targetJobId)
  const team = target
    ? sqlite.prepare("SELECT 1 FROM rooms WHERE id = ? AND role = 'team'").get(target.room_id)
    : undefined
  if (!target || !team)
    throw new HttpError(404, 'not_found', 'Couldn’t find that job in the team room.')
  // Bounded like a message part; a longer reply is shared up to the limit with a note.
  const full = redact(textOf(source.parts))
  const text =
    full.length > SHARED_CHARS
      ? `${full.slice(0, SHARED_CHARS - 40)}\n… (shortened when shared)`
      : full
  if (!text) throw new HttpError(400, 'bad_request', 'That message has no text to share.')
  const id = randomUUID()
  const drafts = storeMessage(
    sqlite,
    {
      id,
      roomId: target.room_id,
      author: { kind: 'you' },
      to: [],
      parts: [
        {
          kind: 'shared',
          from: {
            roomId: source.roomId,
            jobId: source.jobId ?? '',
            messageId: source.id,
            agentId: source.author.kind === 'agent' ? source.author.agentId : null,
            at: source.createdAt,
          },
          text,
        },
      ],
      createdAt: now,
      streaming: false,
      refs: [],
      jobId: target.id,
    },
    now,
  )
  return { messageId: id, drafts }
}

const PinRowSchema = z.object({ message_id: z.string(), pinned_at: z.string(), parts: z.string() })

export function listPins(sqlite: DatabaseSync, roomId: string): RoomPin[] {
  return z
    .array(PinRowSchema)
    .parse(
      sqlite
        .prepare(
          `SELECT p.message_id, p.pinned_at, m.parts FROM room_pins p JOIN messages m ON m.id = p.message_id
           WHERE p.room_id = ? AND m.deleted_at IS NULL ORDER BY p.pinned_at DESC, p.message_id`,
        )
        .all(roomId),
    )
    .map((row) => ({
      messageId: row.message_id,
      text: redact(textOf(z.array(MessagePartSchema).parse(JSON.parse(row.parts)))),
      pinnedAt: row.pinned_at,
    }))
}

export function pinMessage(
  sqlite: DatabaseSync,
  roomId: string,
  messageId: string,
  now: string,
): DomainEventDraft[] {
  if (
    !sqlite
      .prepare('SELECT 1 FROM messages WHERE id = ? AND room_id = ? AND deleted_at IS NULL')
      .get(messageId, roomId)
  )
    throw new HttpError(404, 'not_found', 'Couldn’t find that message.')
  if (
    sqlite
      .prepare('SELECT 1 FROM room_pins WHERE room_id = ? AND message_id = ?')
      .get(roomId, messageId)
  )
    return []
  if (listPins(sqlite, roomId).length >= PINS_LIMIT)
    throw new HttpError(
      409,
      'too_many_pins',
      `A room holds at most ${PINS_LIMIT} pinned decisions. Unpin one first.`,
    )
  sqlite
    .prepare('INSERT INTO room_pins (room_id, message_id, pinned_at) VALUES (?, ?, ?)')
    .run(roomId, messageId, now)
  return [{ type: 'room.pins.changed', data: { roomId } }]
}

export function unpinMessage(
  sqlite: DatabaseSync,
  roomId: string,
  messageId: string,
): DomainEventDraft[] {
  const result = sqlite
    .prepare('DELETE FROM room_pins WHERE room_id = ? AND message_id = ?')
    .run(roomId, messageId)
  return result.changes ? [{ type: 'room.pins.changed', data: { roomId } }] : []
}

/** The room's pinned decisions for a turn's input, newest first, bounded; null when there are none. */
export function pinsContext(sqlite: DatabaseSync, roomId: string): string | null {
  const pins = listPins(sqlite, roomId)
  if (!pins.length) return null
  const lines: string[] = []
  let size = 0
  for (const pin of pins) {
    const line = `- ${pin.text.replace(/\s+/g, ' ').trim()}`
    if (size + line.length > PINS_CONTEXT_BYTES && lines.length) break
    lines.push(redactBounded(line, PINS_CONTEXT_BYTES))
    size += line.length + 1
  }
  return ['Decisions pinned in this room:', ...lines].join('\n')
}

/**
 * What a turn gets besides its job's messages (§5 items 3–4): the room's pinned decisions and the frozen summaries of
 * the jobs the message it answers references. Null when there is neither.
 */
export function crossContext(
  sqlite: DatabaseSync,
  roomId: string,
  parentMessageId: string,
): string | null {
  const parent = sqlite.prepare('SELECT * FROM messages WHERE id = ?').get(parentMessageId)
  const sections = [
    pinsContext(sqlite, roomId),
    parent === undefined ? null : refsContext(messageFromRow(parent).parts),
  ].filter((section) => section !== null)
  return sections.length ? sections.join('\n\n') : null
}
