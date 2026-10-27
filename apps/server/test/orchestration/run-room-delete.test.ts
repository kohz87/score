import { afterEach, expect, test } from 'vitest'
import { createJob } from '../../src/domain/exchanges/store.ts'
import { deleteRoom } from '../../src/domain/room-delete.ts'
import { ensureTeamRoom, teamRoomId } from '../../src/domain/team-room.ts'
import { harness, type Harness } from './harness.ts'

// 3.7.12 (owner): deleting a run's room also deletes the team-room job that started it, so its thread leaves the
// Threads list; the job delete is the ordinary one (Undo can bring it back).

let h: Harness
afterEach(async () => {
  await h?.close()
})

test('deleting a finished run’s room deletes the job that started it, and only that job', async () => {
  h = await harness()
  const id = await h.create({ gatePolicy: 'none' })
  await h.until(() => h.orch.summary(id).status === 'succeeded')
  const now = new Date().toISOString()
  const { started, other } = h.db.tx((sqlite) => {
    ensureTeamRoom(sqlite, ['lead', 'builder'], now)
    const team = teamRoomId(sqlite)!
    return {
      started: createJob(sqlite, team, 'Review the cards', now, {
        recipe: { kind: 'orchestration', ref: id },
      }).job.id,
      other: createJob(sqlite, team, 'Something else', now).job.id,
    }
  })
  const roomId = h.orch.summary(id).roomId
  const name = (
    h.db.sqlite.prepare('SELECT name FROM rooms WHERE id = ?').get(roomId) as { name: string }
  ).name
  const events = h.db.tx((sqlite) => deleteRoom(sqlite, roomId, name, now))
  expect(events.map((event) => event.type)).toContain('job.deleted')
  expect(events.at(-1)).toEqual({ type: 'room.deleted', data: { id: roomId } })
  const deleted = (jobId: string) =>
    (
      h.db.sqlite.prepare('SELECT deleted_at FROM jobs WHERE id = ?').get(jobId) as {
        deleted_at: string | null
      }
    ).deleted_at
  expect(deleted(started)).not.toBeNull()
  expect(deleted(other)).toBeNull()
})
