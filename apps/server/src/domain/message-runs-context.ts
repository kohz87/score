import type { DatabaseSync } from 'node:sqlite'
import { redact, redactBounded } from '../redact.ts'
import { crossContext } from './exchanges/sharing.ts'
import { defaultJobId } from './job-sessions.ts'
import { agentText } from './message-text.ts'
import { messageFromRow } from './rooms.ts'
import { summaryContext } from './room-summaries.ts'

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
