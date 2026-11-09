import type { Job, Message, SubagentRow } from '@score/contract'
import { expect, test } from 'vitest'
import {
  attachSubagentRows,
  subagentControlLabel,
  subagentCostText,
  subagentCounts,
  subagentJobLine,
  subagentRowState,
} from './subagent-model.ts'

const row = (over: Partial<SubagentRow> = {}): SubagentRow => ({
  id: 'sub-1',
  jobId: 'job-1',
  agentId: 'lead',
  goal: 'Read the feed code',
  state: 'running',
  waitingOnYou: false,
  startedAt: '2026-11-09T01:00:00.000Z',
  endedAt: null,
  costUsd: null,
  tokens: null,
  ...over,
})

test('counts done, failed, running and waiting; a waiting row is not also running', () => {
  const rows = [
    row({ id: 'a', state: 'done' }),
    row({ id: 'b', state: 'failed' }),
    row({ id: 'c', state: 'running' }),
    row({ id: 'd', state: 'running', waitingOnYou: true }),
  ]
  expect(subagentCounts(rows)).toEqual({ total: 4, done: 1, failed: 1, running: 1, waiting: 1 })
  expect(subagentJobLine(rows)).toBe('1 of 4 subagents done')
})

test('no rows give no job line, so the job’s line stays as it was', () => {
  expect(subagentJobLine([])).toBeNull()
})

test('cost: dollars are summed and marked about; unknown is a dash, never $0', () => {
  expect(subagentCostText([row({ costUsd: 0.2 }), row({ costUsd: 0.22 })])).toBe('about $0.42')
  expect(subagentCostText([row({ costUsd: null }), row({ costUsd: null })])).toBe('—')
  expect(subagentCostText([])).toBe('—')
})

test('cost: tokens show when a route has no dollars', () => {
  expect(subagentCostText([row({ tokens: 1200 }), row({ tokens: 300 })])).toBe('1,500 tokens')
  expect(subagentCostText([row({ costUsd: null, tokens: null })])).toBe('—')
})

test('state words follow the mock-up, and waiting outranks running', () => {
  expect(subagentRowState(row({ state: 'done' }))).toBe('Done')
  expect(subagentRowState(row({ state: 'failed' }))).toBe('Failed')
  expect(subagentRowState(row({ state: 'running' }))).toBe('Working')
  expect(subagentRowState(row({ state: 'running', waitingOnYou: true }))).toBe('Waiting')
})

const job = (subagents: Job['subagents']) => ({ subagents }) as Pick<Job, 'subagents'>
const limits = (over: Partial<NonNullable<Job['subagents']>>) => ({
  enabled: true,
  maxConcurrent: null,
  maxTotal: 20,
  used: 0,
  ...over,
})

test('the control label: off, the agent’s own limit, a lower number, and Claude Code’s on', () => {
  expect(subagentControlLabel(job(limits({ enabled: false })), undefined)).toBe('Subagents: off')
  expect(subagentControlLabel(job(limits({})), { control: 'limits', maxConcurrent: 4 })).toBe(
    'Subagents: up to 4',
  )
  expect(
    subagentControlLabel(job(limits({ maxConcurrent: 2 })), {
      control: 'limits',
      maxConcurrent: 4,
    }),
  ).toBe('Subagents: 2')
  expect(subagentControlLabel(job(limits({})), { control: 'on_off', maxConcurrent: 4 })).toBe(
    'Subagents: on',
  )
})

const message = (
  id: string,
  agentId: string,
  jobId: string,
  createdAt: string,
): Pick<Message, 'id' | 'jobId' | 'author' | 'createdAt'> => ({
  id,
  jobId,
  createdAt,
  author: { kind: 'agent', agentId } as Message['author'],
})

test('two jobs with the same agent make two cards, each on its own job’s message', () => {
  const rows = [
    row({ id: 'a', jobId: 'job-1', startedAt: '2026-11-09T01:05:00.000Z' }),
    row({ id: 'b', jobId: 'job-2', startedAt: '2026-11-09T02:05:00.000Z' }),
  ]
  const messages = [
    message('m1', 'lead', 'job-1', '2026-11-09T01:00:00.000Z'),
    message('m2', 'lead', 'job-2', '2026-11-09T02:00:00.000Z'),
  ]
  const attached = attachSubagentRows(rows, messages)
  expect(attached.get('m1')?.map((item) => item.id)).toEqual(['a'])
  expect(attached.get('m2')?.map((item) => item.id)).toEqual(['b'])
})

test('a card attaches to the agent’s latest message before its first row, and a missing agent drops its rows', () => {
  const rows = [row({ id: 'a', startedAt: '2026-11-09T01:30:00.000Z' })]
  const messages = [
    message('early', 'lead', 'job-1', '2026-11-09T00:50:00.000Z'),
    message('late', 'lead', 'job-1', '2026-11-09T01:20:00.000Z'),
    message('after', 'lead', 'job-1', '2026-11-09T02:00:00.000Z'),
  ]
  expect(
    attachSubagentRows(rows, messages)
      .get('late')
      ?.map((item) => item.id),
  ).toEqual(['a'])
  expect(
    attachSubagentRows(rows, [message('other', 'builder', 'job-1', '2026-11-09T01:00:00.000Z')])
      .size,
  ).toBe(0)
})
