import type { SubagentRow } from '@score/contract'
import { describe, expect, test } from 'vitest'
import { buildSubagentLayer, subagentLayerRow } from './subagent-layer-model.ts'

const row = (id: string, patch: Partial<SubagentRow> = {}): SubagentRow => ({
  id,
  jobId: 'job-1',
  agentId: 'lead',
  goal: `goal ${id}`,
  state: 'done',
  waitingOnYou: false,
  startedAt: '2026-11-09T10:00:00.000Z',
  endedAt: '2026-11-09T10:00:12.000Z',
  costUsd: 0.02,
  tokens: null,
  ...patch,
})

const job = (subagents: { maxConcurrent: number | null; maxTotal: number; used: number } | null) =>
  ({
    subagents: subagents && { enabled: true, ...subagents },
  }) as Parameters<typeof buildSubagentLayer>[0]

describe('the SUBAGENTS layer (SA.3 part 8)', () => {
  test('no rows, no layer', () => {
    expect(
      buildSubagentLayer(
        job({ maxConcurrent: null, maxTotal: 20, used: 0 }),
        [],
        undefined,
        'lead',
      ),
    ).toBeNull()
  })

  test('the node and the header line, from the mock-up', () => {
    const rows = [
      row('a'),
      row('b', { endedAt: '2026-11-09T10:00:09.000Z', costUsd: 0.01 }),
      row('c', { endedAt: '2026-11-09T10:00:31.000Z', costUsd: 0.05 }),
      row('d', { state: 'running', endedAt: null, costUsd: null, waitingOnYou: true }),
    ]
    const model = buildSubagentLayer(
      job({ maxConcurrent: null, maxTotal: 20, used: 6 }),
      rows,
      { maxConcurrent: 4 },
      'lead',
    )
    expect(model).toMatchObject({
      title: '4 subagents, 3 done',
      detail: 'lead’s own helpers · up to 4 at once',
      headerLine: '6 of 20 subagents used',
      atOnce: 'up to 4',
      thisJob: '6 of 20',
      cost: 'about $0.08',
      working: false,
    })
    expect(model!.rows.map((item) => item.state)).toEqual(['Done', 'Done', 'Done', 'Waiting'])
  })

  test('working while a subagent runs; the job limit without a count reads as the agent’s own', () => {
    const model = buildSubagentLayer(
      job({ maxConcurrent: 2, maxTotal: 20, used: 1 }),
      [row('a', { state: 'running', endedAt: null, costUsd: null })],
      { maxConcurrent: 4 },
      'lead',
    )
    expect(model).toMatchObject({
      atOnce: '2',
      thisJob: '1 of 20',
      working: true,
      title: '1 subagent, 0 done',
    })
  })
})

describe('a row’s facts', () => {
  test('the time once it ended, then the cost; unknown cost is a dash, never $0', () => {
    expect(subagentLayerRow(row('a'))).toMatchObject({ state: 'Done', meta: '12 s · about $0.02' })
    expect(subagentLayerRow(row('b', { costUsd: null, tokens: null }))).toMatchObject({
      meta: '12 s · —',
    })
    expect(subagentLayerRow(row('c', { costUsd: null, tokens: 1200 }))).toMatchObject({
      meta: '12 s · 1,200 tokens',
    })
  })

  test('a waiting or running row says so instead of a time', () => {
    expect(
      subagentLayerRow(row('w', { waitingOnYou: true, endedAt: null, costUsd: 0.03 })),
    ).toMatchObject({
      state: 'Waiting',
      meta: 'needs you · about $0.03',
    })
    expect(
      subagentLayerRow(row('r', { state: 'running', endedAt: null, costUsd: null })),
    ).toMatchObject({
      state: 'Working',
      meta: 'working · —',
    })
  })
})
