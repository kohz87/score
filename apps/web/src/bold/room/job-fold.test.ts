import { expect, test } from 'vitest'
import { foldedJobIds, isFinishedJob } from './job-fold.ts'
import { makeJob, makeMessage } from './room-test-utils.tsx'

const done = makeJob({ id: 'a', state: 'done' })
const closed = makeJob({ id: 'b', state: 'closed' })
const working = makeJob({ id: 'c', state: 'working' })
const none = new Set<string>()
const base = {
  expanded: none,
  isPinned: () => false,
  approvalPointerIds: none,
  seek: null,
  waitingJobIds: none,
  ready: true,
}

test('done and closed jobs fold; working jobs and the room thread do not', () => {
  expect(isFinishedJob(makeJob({ isDefault: true, state: 'done' }))).toBe(false)
  const folded = foldedJobIds({ ...base, jobs: [done, closed, working], messages: [] })
  expect([...folded].sort()).toEqual(['a', 'b'])
})

test('an opened job stays open', () => {
  const folded = foldedJobIds({ ...base, jobs: [done], messages: [], expanded: new Set(['a']) })
  expect(folded.size).toBe(0)
})

test('a pinned message or a waiting approval keeps a job expanded', () => {
  const pinned = makeMessage({ id: 'm1', jobId: 'a' })
  const approval = makeMessage({
    id: 'm2',
    jobId: 'b',
    parts: [{ kind: 'approval', approvalId: 'ap-1' }],
  })
  const folded = foldedJobIds({
    ...base,
    jobs: [done, closed],
    messages: [pinned, approval],
    isPinned: (id) => id === 'm1',
    approvalPointerIds: new Set(['ap-1']),
  })
  expect(folded.size).toBe(0)
})

test('a waiting exchange or a reply the model did not process keeps a job expanded', () => {
  expect(
    foldedJobIds({ ...base, jobs: [done], messages: [], waitingJobIds: new Set(['a']) }).size,
  ).toBe(0)
  const failed = makeMessage({
    id: 'm3',
    jobId: 'b',
    author: { kind: 'agent', agentId: 'lead' },
    parts: [{ kind: 'text', text: 'Your request was not processed' }],
  })
  expect(foldedJobIds({ ...base, jobs: [closed], messages: [failed] }).size).toBe(0)
})

test('nothing folds until the needs-you data has loaded without error', () => {
  expect(foldedJobIds({ ...base, jobs: [done, closed], messages: [], ready: false }).size).toBe(0)
})
