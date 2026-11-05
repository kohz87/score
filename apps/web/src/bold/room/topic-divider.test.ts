import type { Job, Message } from '@score/contract'
import { expect, test } from 'vitest'
import { emptyTopics, topicDividers, topicStateText } from './topic-divider.tsx'

const job = (id: string, over: Partial<Job> = {}): Job => ({
  id,
  roomId: 'r',
  title: id,
  state: 'open',
  holderAgentId: null,
  isDefault: false,
  exchangeBudget: 8,
  jobTurnLimit: 40,
  unread: 0,
  activeAgents: [],
  lastMessageAt: null,
  messageCount: 1,
  summary: null,
  source: null,
  reportBack: null,
  spendCapUsd: null,
  recipe: null,
  createdAt: '2026-11-03T10:00:00.000Z',
  updatedAt: '2026-11-03T10:00:00.000Z',
  ...over,
})
const message = (id: string, jobId: string, at: string): Message => ({
  id,
  roomId: 'r',
  jobId,
  author: { kind: 'you' },
  to: [],
  parts: [{ kind: 'text', text: id }],
  refs: [],
  createdAt: at,
  streaming: false,
})

test('a divider opens each topic, none before the general conversation, and a return is marked', () => {
  const jobs = [job('general', { isDefault: true }), job('feed'), job('socket')]
  const messages = [
    message('m1', 'general', '2026-11-03T10:01:00.000Z'),
    message('m2', 'feed', '2026-11-03T10:02:00.000Z'),
    message('m3', 'feed', '2026-11-03T10:03:00.000Z'),
    message('m4', 'general', '2026-11-03T10:04:00.000Z'),
    message('m5', 'feed', '2026-11-03T10:05:00.000Z'),
    message('m6', 'socket', '2026-11-03T10:06:00.000Z'),
  ]
  const plan = topicDividers(jobs, messages)
  expect(plan.has('m1')).toBe(false)
  expect(plan.get('m2')).toMatchObject({ again: false, job: { id: 'feed' } })
  expect(plan.has('m3')).toBe(false)
  expect(plan.get('m4')).toEqual({ job: null, again: false })
  expect(plan.get('m5')).toMatchObject({ again: true, job: { id: 'feed' } })
  expect(plan.get('m6')).toMatchObject({ job: { id: 'socket' } })
})

test('a topic nobody has written in yet still gets its divider, and states read in plain words', () => {
  const fresh = job('fresh', { messageCount: 0 })
  expect(
    emptyTopics([fresh, job('old')], [message('m1', 'old', '2026-11-03T10:01:00.000Z')]),
  ).toEqual([fresh])
  expect(topicStateText(job('a', { state: 'waiting_on_you' }))).toBe('your turn')
  expect(topicStateText(job('a2', { state: 'waiting_on_you', needsYou: true }))).toBe('needs you')
  expect(topicStateText(job('b', { state: 'done' }))).toBe('done')
  expect(topicStateText(job('c', { state: 'closed' }))).toBe('closed')
})
