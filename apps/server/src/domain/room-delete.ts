import type { RoomDeletePlan } from '@score/contract'
import type { DatabaseSync } from 'node:sqlite'
import { HttpError } from '../errors.ts'
import type { DomainEventDraft } from '../hub/ingest.ts'
import { releaseMessageMedia, releaseShareMedia } from './media-refs.ts'
import { isHeld, ownerOfRoom } from './orchestration/ownership.ts'
import { pruneOrchestrationRows } from './orchestration/prune.ts'
import { deleteJob } from './exchanges/job-life.ts'
import { readOrch } from './orchestration/store.ts'
import { compactingSessions, rewindingRooms } from './room-rewinding.ts'
import { roomRow } from './rooms.ts'

const count = (sqlite: DatabaseSync, sql: string, ...args: string[]): number =>
  Number((sqlite.prepare(sql).get(...args) as { n: number | bigint }).n)

function blockedBy(sqlite: DatabaseSync, roomId: string, kind: string): RoomDeletePlan['blocked'] {
  if (kind === 'direct') return 'direct'
  if (isHeld(ownerOfRoom(sqlite, roomId))) return 'orchestration_owned'
  if (
    rewindingRooms.has(roomId) ||
    [...compactingSessions].some((key) => key.startsWith(`${roomId}\0`)) ||
    count(
      sqlite,
      `SELECT count(*) AS n FROM message_runs WHERE room_id = ? AND state IN ('pending', 'active')`,
      roomId,
    ) > 0 ||
    // A question still waiting for (or delivering) your answer belongs to a run that waits on it (3.6.0).
    count(
      sqlite,
      `SELECT count(*) AS n FROM agent_questions
       WHERE (room_id = ?1 OR job_id IN (SELECT id FROM jobs WHERE room_id = ?1))
         AND (status = 'pending' OR delivery = 'delivering')`,
      roomId,
    ) > 0
  )
    return 'room_busy'
  return null
}

/** What deleting the room removes, for the confirmation dialog (PLAN 5.36). Changes nothing. */
export function roomDeletePlan(sqlite: DatabaseSync, roomId: string): RoomDeletePlan {
  const room = roomRow(sqlite, roomId)
  const files = new Set<string>()
  for (const { parts } of sqlite
    .prepare('SELECT parts FROM messages WHERE room_id = ? AND deleted_at IS NULL')
    .all(roomId) as { parts: string }[])
    for (const part of JSON.parse(parts) as { kind?: string; mediaId?: string }[])
      if ((part.kind === 'image' || part.kind === 'document') && part.mediaId)
        files.add(part.mediaId)
  return {
    name: room.name,
    messages: count(
      sqlite,
      'SELECT count(*) AS n FROM messages WHERE room_id = ? AND deleted_at IS NULL',
      roomId,
    ),
    files: files.size,
    runs:
      count(sqlite, 'SELECT count(*) AS n FROM message_runs WHERE room_id = ?', roomId) +
      count(
        sqlite,
        `SELECT count(*) AS n FROM orc_attempts WHERE orchestration_id IN (SELECT id FROM orchestrations WHERE room_id = ?)`,
        roomId,
      ),
    briefs: count(sqlite, 'SELECT count(*) AS n FROM briefs WHERE room_id = ?', roomId),
    blocked: blockedBy(sqlite, roomId, room.kind),
  }
}

/**
 * Deletes a room and what Score kept for it, in the caller's transaction (PLAN 5.36). Hermes sessions, runs and
 * reports are untouched. A released orchestration's records are pruned first with the executor's own path.
 */
export function deleteRoom(
  sqlite: DatabaseSync,
  roomId: string,
  confirm: string,
  nowIso: string,
): DomainEventDraft[] {
  const room = roomRow(sqlite, roomId)
  if (confirm !== room.name)
    throw new HttpError(400, 'bad_request', 'Type the room’s name to delete it.')
  const blocked = blockedBy(sqlite, roomId, room.kind)
  if (blocked === 'direct')
    throw new HttpError(409, 'conflict', 'A direct room is the agent’s home and can’t be deleted.')
  if (blocked === 'orchestration_owned') {
    // The owner's details come with the standard refusal.
    const owner = ownerOfRoom(sqlite, roomId)!
    throw new HttpError(
      409,
      'orchestration_owned',
      'This belongs to an orchestration run. Use the run controls instead.',
      {
        orchestrationId: owner.orchestration.id,
        state: owner.state,
        action: 'room.delete',
        planner: owner.orchestration.planner,
      },
    )
  }
  if (blocked === 'room_busy')
    throw new HttpError(409, 'room_busy', 'An agent is working in this room; stop it first.')
  const orchestration = sqlite
    .prepare('SELECT id FROM orchestrations WHERE room_id = ?')
    .get(roomId) as { id: string } | undefined
  if (orchestration) pruneOrchestrationRows(sqlite, readOrch(sqlite, orchestration.id)!, nowIso)
  // 3.7.12 (owner): the team-room job that started this run goes with it, as a job delete (undo brings it back). Its
  // thread would otherwise stay in the Threads list pointing at a run that no longer exists.
  const startedBy = orchestration
    ? (
        sqlite
          .prepare(
            'SELECT id FROM jobs WHERE recipe_ref = ? AND room_id != ? AND deleted_at IS NULL',
          )
          .all(orchestration.id, roomId) as { id: string }[]
      ).flatMap((job) => {
        // A job still working (a paused exchange, a pending turn) stays: the room delete isn't refused for it.
        try {
          return deleteJob(sqlite, job.id, nowIso)
        } catch (error) {
          if (error instanceof HttpError && error.status === 409) return []
          throw error
        }
      })
    : []

  const briefs = (
    sqlite.prepare('SELECT id FROM briefs WHERE room_id = ?').all(roomId) as { id: string }[]
  ).map((row) => row.id)
  for (const id of briefs)
    for (const table of [
      'brief_tasks',
      'brief_paused_tasks',
      'brief_plan_starts',
      'brief_edges',
      'brief_blocks',
      'team_paused_briefs',
    ])
      sqlite.prepare(`DELETE FROM ${table} WHERE brief_id = ?`).run(id)
  sqlite.prepare('DELETE FROM plan_start_runs WHERE room_id = ?').run(roomId)
  sqlite.prepare('DELETE FROM briefs WHERE room_id = ?').run(roomId)
  sqlite
    .prepare(
      'DELETE FROM exchange_actions WHERE turn_id IN (SELECT turn_id FROM message_runs WHERE room_id = ?)',
    )
    .run(roomId)
  sqlite.prepare('DELETE FROM message_runs WHERE room_id = ?').run(roomId)
  sqlite
    .prepare('DELETE FROM exchanges WHERE job_id IN (SELECT id FROM jobs WHERE room_id = ?)')
    .run(roomId)
  // Messages already deleted released their media then.
  releaseMessageMedia(
    sqlite,
    (
      sqlite
        .prepare('SELECT id FROM messages WHERE room_id = ? AND deleted_at IS NULL')
        .all(roomId) as { id: string }[]
    ).map((row) => row.id),
  )
  releaseShareMedia(
    sqlite,
    (
      sqlite.prepare('SELECT id FROM room_shares WHERE room_id = ?').all(roomId) as { id: string }[]
    ).map((row) => row.id),
  )
  for (const table of [
    'room_pins',
    'room_versions',
    'room_shares',
    'room_reads',
    'room_sessions',
    'rewind_holds',
    'task_rooms',
    'messages',
  ])
    sqlite.prepare(`DELETE FROM ${table} WHERE room_id = ?`).run(roomId)
  sqlite.prepare('DELETE FROM agent_questions WHERE room_id = ?').run(roomId)
  for (const table of [
    'job_sessions',
    'job_reads',
    'coding_sessions',
    'review_comments',
    'agent_questions',
    'coding_pending_terminals',
  ])
    sqlite
      .prepare(`DELETE FROM ${table} WHERE job_id IN (SELECT id FROM jobs WHERE room_id = ?)`)
      .run(roomId)
  // The calls that started this room's jobs go too: a repeat of one later starts a new job instead of naming a gone one.
  sqlite
    .prepare('DELETE FROM trigger_calls WHERE job_id IN (SELECT id FROM jobs WHERE room_id = ?)')
    .run(roomId)
  sqlite.prepare('DELETE FROM jobs WHERE room_id = ?').run(roomId)
  // A team's triggers go back to the first team room (3.6.0).
  sqlite.prepare('UPDATE triggers SET team_room_id = NULL WHERE team_room_id = ?').run(roomId)
  sqlite.prepare('DELETE FROM rooms WHERE id = ?').run(roomId)
  return [...startedBy, { type: 'room.deleted', data: { id: roomId } }]
}
