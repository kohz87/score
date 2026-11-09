import type { SubagentRow } from '@score/contract'
import { beforeEach, expect, test, vi } from 'vitest'
import { apiFetch } from '../../data/api.ts'
import { jobSubagentRowsQuery, roomSubagentRowsQuery } from './subagent-queries.ts'

vi.mock('../../data/api.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../data/api.ts')>()),
  apiFetch: vi.fn(),
}))

const row = (over: Partial<SubagentRow> = {}): SubagentRow => ({
  id: 'sub-1',
  jobId: 'job-a',
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

/** A stream event as the reducers see it: only `type` and `data` matter here. */
const event = (type: string, data: unknown) => ({ type, data }) as never

const approval = (over: Record<string, unknown>) => ({
  id: 'appr-1',
  agentId: 'lead',
  subagentId: 'sub-1',
  status: 'pending',
  ...over,
})

beforeEach(() => {
  vi.mocked(apiFetch).mockReset()
})

function readsByJob(reads: Record<string, unknown>) {
  vi.mocked(apiFetch).mockImplementation(async (path: string) => {
    const jobId = path.split('/')[1]!
    const read = reads[jobId]
    if (read instanceof Error) throw read
    return read
  })
}

test('the room’s asOfSeq is the lowest read, so no event after either read is lost', async () => {
  readsByJob({
    'job-a': { asOfSeq: 9, items: [row({ id: 'a', jobId: 'job-a' })] },
    'job-b': { asOfSeq: 4, items: [row({ id: 'b', jobId: 'job-b' })] },
  })
  const snapshot = await roomSubagentRowsQuery(['job-a', 'job-b']).fetch()
  expect(snapshot.asOfSeq).toBe(4)
  expect(snapshot.data.map((item) => item.id)).toEqual(['a', 'b'])
})

test('one failed read counts its job as no rows; the others still load', async () => {
  readsByJob({
    'job-a': new Error('down'),
    'job-b': { asOfSeq: 6, items: [row({ id: 'b', jobId: 'job-b' })] },
  })
  const snapshot = await roomSubagentRowsQuery(['job-a', 'job-b']).fetch()
  expect(snapshot.asOfSeq).toBe(6)
  expect(snapshot.data.map((item) => item.id)).toEqual(['b'])
})

test('the room query fails only when every read fails', async () => {
  readsByJob({ 'job-a': new Error('down'), 'job-b': new Error('down') })
  await expect(roomSubagentRowsQuery(['job-a', 'job-b']).fetch()).rejects.toThrow('down')
})

test('an approval from a subagent opens and closes its row on the job query', () => {
  const query = jobSubagentRowsQuery('job-a')
  const data = { asOfSeq: 1, items: [row()] }
  const opened = query.reduce(data, event('approval.requested', approval({})))
  expect(opened.items[0]?.waitingOnYou).toBe(true)
  const closed = query.reduce(opened, event('approval.updated', approval({ status: 'approved' })))
  expect(closed.items[0]?.waitingOnYou).toBe(false)
})

test('an approval from a subagent opens and closes its row on the room query', () => {
  const query = roomSubagentRowsQuery(['job-a'])
  const opened = query.reduce([row()], event('approval.requested', approval({})))
  expect(opened[0]?.waitingOnYou).toBe(true)
  const closed = query.reduce(opened, event('approval.updated', approval({ status: 'denied' })))
  expect(closed[0]?.waitingOnYou).toBe(false)
})

test('an approval naming no subagent, or one not in the data, changes nothing', () => {
  const query = roomSubagentRowsQuery(['job-a'])
  const rows = [row()]
  expect(query.reduce(rows, event('approval.requested', approval({ subagentId: undefined })))).toBe(
    rows,
  )
  expect(query.reduce(rows, event('approval.requested', approval({ subagentId: 'other' })))).toBe(
    rows,
  )
})
