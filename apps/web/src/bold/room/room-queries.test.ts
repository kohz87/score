import type { StreamEvent } from '@score/contract'
import { expect, test } from 'vitest'
import { makeJob } from './room-test-utils.tsx'
import { roomJobsQuery } from './room-queries.ts'

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
