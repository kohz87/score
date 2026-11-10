import type { DatabaseSync } from 'node:sqlite'
import { RepeatingJobSchema, type RepeatingJob, type RoutineSummary } from '@score/contract'
import { HttpError } from '../errors.ts'
import type { DomainEventDraft } from '../hub/ingest.ts'
import { storeMessage } from './rooms.ts'

// Decision 183: where a repeating job's results go. Score keeps it (Hermes's own `deliver` stays local): each run's
// saved output written after `since` is posted into the chat as the agent's message, once.

const agentOf = (routineId: string): string => routineId.split(':', 1)[0]!

export function targetOf(
  sqlite: DatabaseSync,
  routineId: string,
): { roomId: string; roomName: string } | null {
  const row = sqlite
    .prepare(
      `SELECT t.room_id, r.name FROM routine_targets t JOIN rooms r ON r.id = t.room_id WHERE t.routine_id = ?`,
    )
    .get(routineId) as { room_id: string; name: string } | undefined
  return row ? { roomId: row.room_id, roomName: row.name } : null
}

/** The list's view of one agent's job: the summary plus who has it and where its results go. */
export function repeatingJob(sqlite: DatabaseSync, summary: RoutineSummary): RepeatingJob {
  return RepeatingJobSchema.parse({
    ...summary,
    agentId: agentOf(summary.id),
    nextRunAt: summary.nextRunAt ?? null,
    provider: summary.provider ?? null,
    deliverTo: targetOf(sqlite, summary.id),
  })
}

/** Sets (or, with null, clears) where results go. Only runs saved from now on are posted. */
export function setTarget(
  sqlite: DatabaseSync,
  routineId: string,
  roomId: string | null,
  title: string,
  now: string,
): void {
  if (roomId === null) {
    sqlite.prepare('DELETE FROM routine_targets WHERE routine_id = ?').run(routineId)
    return
  }
  if (!sqlite.prepare('SELECT 1 FROM rooms WHERE id = ?').get(roomId))
    throw new HttpError(400, 'bad_request', 'Couldn’t find that chat.')
  sqlite
    .prepare(
      `INSERT INTO routine_targets (routine_id, room_id, title, since, set_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (routine_id) DO UPDATE SET room_id = excluded.room_id, title = excluded.title,
         set_at = excluded.set_at`,
    )
    .run(routineId, roomId, title, now, now)
}

export function retitleTarget(sqlite: DatabaseSync, routineId: string, title: string): void {
  sqlite.prepare('UPDATE routine_targets SET title = ? WHERE routine_id = ?').run(title, routineId)
}

/** A moved job keeps where its results go; the new agent's runs are posted from the move on. */
export function moveTarget(sqlite: DatabaseSync, from: string, to: string, now: string): void {
  sqlite
    .prepare(
      'UPDATE routine_targets SET routine_id = ?, since = ?, set_at = ? WHERE routine_id = ?',
    )
    .run(to, now, now, from)
}

export function targets(
  sqlite: DatabaseSync,
): { routineId: string; roomId: string; title: string; since: string }[] {
  return (
    sqlite
      .prepare('SELECT routine_id, room_id, title, since FROM routine_targets ORDER BY routine_id')
      .all() as { routine_id: string; room_id: string; title: string; since: string }[]
  ).map((row) => ({
    routineId: row.routine_id,
    roomId: row.room_id,
    title: row.title,
    since: row.since,
  }))
}

/** Posts one saved result into the chat, once (the posted table and the ingest identity both hold it). */
export function postOutput(
  sqlite: DatabaseSync,
  target: { routineId: string; roomId: string; title: string },
  output: { file: string; at: string; text: string },
  now: string,
): DomainEventDraft[] {
  const done = sqlite
    .prepare('SELECT 1 FROM routine_outputs_posted WHERE routine_id = ? AND file = ?')
    .get(target.routineId, output.file)
  if (done || !sqlite.prepare('SELECT 1 FROM rooms WHERE id = ?').get(target.roomId)) return []
  const id = `routine:${target.routineId}:${output.file}`
  sqlite
    .prepare(
      'INSERT INTO routine_outputs_posted (routine_id, file, message_id, posted_at) VALUES (?, ?, ?, ?)',
    )
    .run(target.routineId, output.file, id, now)
  return storeMessage(
    sqlite,
    {
      id,
      roomId: target.roomId,
      author: { kind: 'agent', agentId: agentOf(target.routineId) },
      to: [],
      parts: [
        {
          kind: 'text',
          text: `**${target.title}** · repeating job\n\n${output.text || 'The run finished with nothing to say.'}`,
        },
      ],
      createdAt: output.at,
      streaming: false,
      refs: [],
    },
    now,
  )
}
