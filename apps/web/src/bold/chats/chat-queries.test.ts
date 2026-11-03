import type { StreamEvent } from '@score/contract'
import { expect, test } from 'vitest'
import { chatJobsQuery } from './chat-queries.ts'

const job = (id: string, roomId: string) => ({
  id,
  roomId,
  title: id,
  state: 'open',
  isDefault: false,
  holderAgentId: null,
  exchangeBudget: 8,
  jobTurnLimit: 40,
  unread: 0,
  activeAgents: [],
  lastMessageAt: null,
  messageCount: 0,
  summary: null,
  source: null,
  reportBack: null,
  spendCapUsd: null,
  recipe: null,
  createdAt: '2026-11-03T09:00:00.000Z',
  updatedAt: '2026-11-03T09:00:00.000Z',
})
const upsert = (roomId: string, id: string) =>
  ({
    seq: 1,
    ts: '2026-11-03T09:00:00.000Z',
    type: 'job.upserted',
    data: job(id, roomId),
  }) as StreamEvent

test('a job for a listed room that has not been read yet is kept, one for an unlisted room is not', () => {
  const query = chatJobsQuery(['a', 'b'])
  const first = query.reduce({ a: [] }, upsert('b', 'j1'))
  expect(first.b?.map((item) => item.id)).toEqual(['j1'])
  const unlisted = { a: [] }
  expect(query.reduce(unlisted, upsert('run-room', 'j2'))).toBe(unlisted)
})

test('the key is the set of rooms, whatever order they are listed in', () => {
  expect(chatJobsQuery(['b', 'a']).key).toEqual(chatJobsQuery(['a', 'b', 'a']).key)
})
