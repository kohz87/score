import type { StreamEvent } from '@score/contract'
import { expect, test } from 'vitest'
import { makeJob, room } from './room-test-utils.tsx'
import { roomJobsQuery, teamRoomQuery } from './room-queries.ts'

function jobEvent(data: ReturnType<typeof makeJob>): StreamEvent {
  return {
    seq: 2,
    ts: '2026-10-24T09:10:00.000Z',
    type: 'job.upserted',
    data,
  }
}

test('a job.upserted replaces the read model instead of keeping stale unread and activity fields', () => {
  const stale = makeJob({
    id: 'job-1',
    unread: 6,
    activeAgents: ['builder'],
    summary: 'Old summary',
    lastMessageAt: '2026-10-24T09:05:00.000Z',
    messageCount: 8,
  })
  const fresh = makeJob({
    id: 'job-1',
    unread: 0,
    activeAgents: [],
    summary: 'Read just now',
    lastMessageAt: null,
    messageCount: 8,
  })

  expect(roomJobsQuery('room-1').reduce([stale], jobEvent(fresh))).toEqual([fresh])
})

test('the team-room read keeps the default job first when a job changes', () => {
  const named = makeJob({
    id: 'job-2',
    title: 'Activity feed',
    createdAt: '2026-10-24T09:02:00.000Z',
  })
  const fallback = makeJob({
    id: 'job-default',
    title: room.name,
    isDefault: true,
    createdAt: '2026-10-24T09:00:00.000Z',
  })

  const next = teamRoomQuery(null).reduce(
    { room, jobs: [named] },
    jobEvent({ ...fallback, unread: 2 }),
  )
  expect(next?.jobs.map((job) => job.id)).toEqual(['job-default', 'job-2'])
  expect(next?.jobs[0]?.unread).toBe(2)
})

test('a deleted team room clears the switcher read', () => {
  expect(
    teamRoomQuery(null).reduce(
      { room, jobs: [] },
      {
        seq: 3,
        ts: '2026-10-24T09:11:00.000Z',
        type: 'room.deleted',
        data: { id: room.id },
      },
    ),
  ).toBeNull()
})
