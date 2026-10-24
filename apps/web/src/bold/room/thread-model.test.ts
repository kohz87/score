import { expect, test } from 'vitest'
import type { Message, OrchestrationSummary } from '@score/contract'
import {
  currentExchange,
  jobSessionId,
  recipeRun,
  recipeSummaryLine,
  threadRounds,
  threadTurns,
} from './thread-model.ts'
import { makeExchange, makeJob, makeMessage } from './room-test-utils.tsx'

const message = (id: string, minute: number, overrides: Partial<Message> = {}) =>
  makeMessage({
    id,
    createdAt: `2026-10-24T10:${String(minute).padStart(2, '0')}:00.000Z`,
    ...overrides,
  })

const review = (id: string, minute: number, verdict: 'approved' | 'changes_requested') =>
  message(id, minute, {
    author: { kind: 'agent', agentId: 'reviewer' },
    parts: [
      { kind: 'text', text: verdict === 'approved' ? 'Looks right.' : 'Please change this.' },
      { kind: 'review', verdict, taskId: null },
    ],
  })

test('the header turn line is the exchange’s used and budget turns', () => {
  expect(threadTurns(makeExchange({ turnsUsed: 5, budget: 8 }))).toBe('5 of 8 turns used')
  expect(threadTurns(undefined)).toBeNull()
})

test('the current exchange is the latest one still working, not a finished older row', () => {
  const done = makeExchange({
    id: 'done',
    state: 'done',
    pause: null,
    createdAt: '2026-10-24T10:00:00.000Z',
  })
  const live = makeExchange({
    id: 'live',
    state: 'live',
    pause: null,
    createdAt: '2026-10-24T10:01:00.000Z',
  })
  const stopped = makeExchange({
    id: 'stopped',
    state: 'stopped',
    pause: null,
    createdAt: '2026-10-24T10:02:00.000Z',
  })
  expect(currentExchange([done])).toBe(done)
  expect(currentExchange([done, live, stopped])).toBe(live)
})

test('a review send-back starts the next visible round and an approved review ends it', () => {
  const messages = [
    message('ask', 1, { author: { kind: 'you' }, parts: [{ kind: 'text', text: 'Draft it.' }] }),
    message('work', 2, { author: { kind: 'agent', agentId: 'lead' } }),
    review('back-1', 3, 'changes_requested'),
    message('work-2', 4, { author: { kind: 'agent', agentId: 'lead' } }),
    review('back-2', 5, 'changes_requested'),
    message('last', 6, { author: { kind: 'agent', agentId: 'lead' } }),
  ]
  const rounds = threadRounds(messages)
  expect(rounds.map((round) => round.label)).toEqual(['Round 1', 'Round 2', 'Round 3'])
  expect(rounds.map((round) => round.messages.map((item) => item.id))).toEqual([
    ['ask', 'work', 'back-1'],
    ['work-2', 'back-2'],
    ['last'],
  ])
  expect(threadRounds([...messages].reverse())[0]?.messages[0]?.id).toBe('ask')
})

test('without review verdicts the page is called messages rather than inventing rounds', () => {
  const rounds = threadRounds([message('one', 1), message('two', 2)])
  expect(rounds).toHaveLength(1)
  expect(rounds[0]?.label).toBe('Messages')
  expect(rounds[0]?.number).toBeNull()
})

test('a job session is named score-room-job-agent on both sides of the contract', () => {
  expect(jobSessionId('team-room', { id: 'job-notes', isDefault: false }, 'reviewer')).toBe(
    'score-team-room-job-notes-reviewer',
  )
})

test('the default job uses the room session, not a job session', () => {
  expect(jobSessionId('team-room', { id: 'job-default', isDefault: true }, 'lead')).toBe(
    'score-team-room-lead',
  )
})

test('a job-limit pause names the job limit instead of the exchange budget', () => {
  const paused = makeExchange({ pause: { reason: 'job_limit', options: ['more_turns', 'stop'] } })
  expect(threadTurns(paused, { jobTurnLimit: 40 })).toBe('Job turn limit reached (40)')
  expect(threadTurns(makeExchange({ turnsUsed: 3 }), { jobTurnLimit: 40 })).toBe(
    '3 of 8 turns used',
  )
})

test('the one exchange is the one that needs you, else the latest live one', () => {
  const live = makeExchange({ id: 'live', state: 'live', pause: null })
  const waiting = makeExchange({ id: 'waiting' })
  expect(currentExchange([waiting, live])?.id).toBe('waiting')
  expect(currentExchange([live, waiting])?.id).toBe('waiting')
})

test('with older messages unloaded the first chunk is not called Round 1', () => {
  const rounds = threadRounds(
    [
      review('a', 1, 'changes_requested'),
      message('b', 2),
      review('c', 3, 'changes_requested'),
      message('d', 4),
    ],
    { hasEarlier: true },
  )
  expect(rounds.map((round) => round.label)).toEqual([
    'Earlier messages',
    'Later in the review',
    'Later in the review',
  ])
  expect(rounds.map((round) => round.key)).toEqual(['a', 'b', 'd'])
  expect(rounds.every((round) => round.number === null)).toBe(true)
})

test('several review exchanges mean no round numbers at all', () => {
  const rounds = threadRounds([review('a', 1, 'changes_requested'), message('b', 2)], {
    reviewExchanges: 2,
  })
  expect(rounds).toHaveLength(1)
  expect(rounds[0]?.label).toBe('Messages')
})

const orchestration: OrchestrationSummary = {
  id: 'orch-activity',
  title: 'Activity feed',
  status: 'running',
  pauseReason: null,
  leadAgentId: 'lead',
  roomId: 'room-1',
  briefId: 'brief-activity',
  gatePolicy: 'lead-asks',
  revision: 1,
  ownership: 'owned',
  steps: { total: 4, active: 1, succeeded: 2, failed: 0 },
  leadTurnsUsed: 1,
  maxLeadTurns: 8,
  needsYou: [],
  createdAt: '2026-10-24T09:00:00.000Z',
  updatedAt: '2026-10-24T10:00:00.000Z',
  endedAt: null,
}

test('a job’s recipe resolves to its run and its step count', () => {
  const job = makeJob({ recipe: { kind: 'orchestration', ref: 'orch-activity' } })
  const match = recipeRun(job.recipe, [orchestration], [])
  expect(match?.kind).toBe('orchestration')
  expect(match && recipeSummaryLine(match)).toBe('2 of 4 steps done')
  expect(recipeRun({ kind: 'workflow', ref: 'wf-missing' }, [orchestration], [])).toBeNull()
  expect(recipeRun(null, [orchestration], [])).toBeNull()
})
