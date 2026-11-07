import type { DatabaseSync } from 'node:sqlite'
import { jobRow } from '../../domain/exchanges/store.ts'
import { teamRoomId } from '../../domain/team-room.ts'
import { seedActivityFeed } from './team-seed-activity-feed.ts'
import { seedDirectChats } from './team-seed-chats.ts'
import { minutes } from './team-seed-helpers.ts'
import { seedPinnedDecision, seedQueueResearch, seedReleaseNotes } from './team-seed-jobs.ts'

// The fake adapter's demo team room (PLAN 11.2c). Every board state the bold-shell UI tasks need is real data in
// Score's own tables: jobs, messages, exchanges, actions, pauses, watch frames, approvals, one-to-one chats, references,
// shares and pins. The rows are made with the same domain functions real turns use so their reads stay in step.
//
// Times are minutes before `nowMs`, so the relative labels in the prototype hold ("just now", "2 min").

/** Seeds the demo team room once; a second start finds the jobs and changes nothing. */
export function seedFakeTeam(sqlite: DatabaseSync, nowMs = Date.now()): void {
  const roomId = teamRoomId(sqlite)
  if (!roomId) throw new Error('seedFakeTeam: the team room must exist first')
  // A deterministic row from the seed is the marker: a second start (or a user's own "Activity feed" job) is untouched.
  if (sqlite.prepare("SELECT 1 FROM messages WHERE id = 'seed_feed_request'").get()) return

  // Members are kept by ensureTeamRoom; the person picks the lead, and demo data picks `lead` for them.
  sqlite
    .prepare(
      'UPDATE rooms SET lead_agent_id = ?, updated_at = ?, version = version + 1 WHERE id = ?',
    )
    .run('lead', minutes(nowMs, 240), roomId)
  // ensureTeamRoom made the room's default job. Team room jobs list the four demo threads; the pinned decision lives
  // in this first one.
  const defaultJob = sqlite
    .prepare('SELECT id FROM jobs WHERE room_id = ? AND is_default = 1')
    .get(roomId) as { id: string }
  if (!jobRow(sqlite, defaultJob.id))
    throw new Error('seedFakeTeam: the team room has no default job')

  const direct = seedDirectChats(sqlite, nowMs)
  seedPinnedDecision(sqlite, roomId, defaultJob.id, nowMs)
  seedActivityFeed(sqlite, roomId, nowMs, direct)
  seedReleaseNotes(sqlite, roomId, nowMs)
  seedQueueResearch(sqlite, roomId, nowMs)
}
