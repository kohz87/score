import { NowSnapshotSchema } from '@score/contract'
import { describe, expect, test } from 'vitest'
import { seedAttempt, withFlag } from '../helpers/kanban-attempts-seed.ts'
import {
  WINDOW,
  at,
  body,
  consumerUrls,
  db,
  iso,
  seedWorld,
  setupKanbanAttemptsConsumersTest,
} from './kanban-attempts-consumers-helpers.ts'

setupKanbanAttemptsConsumersTest()

describe('with attempts off, every existing response is what it was without any attempt', () => {
  test('attempt rows (even a live history) change none of the consumer responses, byte for byte', async () => {
    seedWorld({ attempts: false })
    // The first reads settle lazily seeded state (agents, demo history): compare settled responses only.
    await Promise.all(consumerUrls.map(body))
    const before = await Promise.all(consumerUrls.map(body))
    expect(before.map((r) => r.status)).toEqual(consumerUrls.map(() => 200))
    // Add attempts to the same database.
    db.tx((sqlite) => {
      const rows: Parameters<typeof seedAttempt>[1][] = [
        { attempt: 1, task: 't-done', start: at('10:00'), end: at('10:30') },
        {
          attempt: 5,
          task: 't-open',
          profile: null,
          role: null,
          start: at('11:00'),
          end: at('11:10'),
        },
        {
          attempt: 6,
          task: 't-open',
          profile: null,
          role: null,
          evidence: 'partial',
          start: at('11:50'),
        },
      ]
      for (const row of rows) seedAttempt(sqlite, row)
    })
    const after = await Promise.all(consumerUrls.map(body))
    expect(after).toEqual(before)
    // The attempt detail route does not exist either.
    expect((await body('/api/attempts/kr_00000000-0000-4000-8000-000000000001')).status).toBe(404)
  })

  test('Now keeps its old shape: no unattributed lane, no attempt fields, checks carry a verdict', async () => {
    seedWorld()
    const now = NowSnapshotSchema.parse(JSON.parse((await body(`/api/now?${WINDOW}`)).text))
    expect(now.unattributed).toBeUndefined()
    expect(now.lanes.flatMap((lane) => lane.blocks)).toEqual([])
    for (const item of now.madeToday)
      for (const check of item.checks) expect(['passed', 'unknown']).toContain(check.verdict)
  })
})

describe('Now', () => {
  test('attempt blocks sit in their agent lane; unknown agents get the Unattributed lane; boundaries end the block', async () => {
    seedWorld()
    withFlag(true)
    const now = NowSnapshotSchema.parse(JSON.parse((await body(`/api/now?${WINDOW}`)).text))
    const builder = now.lanes.find((lane) => lane.agent.id === 'builder')!
    const ids = builder.blocks.map((block) => block.attemptId)
    // Copies and the closed lineage's attempt are not in the builder's lane twice; partial ones are marked.
    expect(ids).toHaveLength(new Set(ids).size)
    const first = builder.blocks.find((block) => block.order?.[1] === 1)!
    expect(first).toMatchObject({
      runId: null,
      state: 'done',
      provenance: 'proven',
      taskId: 't-done',
      label: 'Done work',
      end: iso('10:30'),
    })
    expect(builder.blocks.find((block) => block.order?.[1] === 7)?.provenance).toBe('partial')
    // The observation boundary is where the block ends; the attempt did not end there.
    const boundary = builder.blocks.find((block) => block.order?.[1] === 8)!
    expect(boundary).toMatchObject({
      state: 'done',
      end: iso('11:45'),
      observationEndedAt: iso('11:45'),
    })
    // The reviewer role comes from the stored claim role: a review label, and the rejection is a block too.
    const reviewer = now.lanes.find((lane) => lane.agent.id === 'reviewer')!
    expect(reviewer.blocks.map((block) => block.label)).toEqual([
      'Review: Done work',
      'Review: Done work',
    ])
    // Unattributed lane, ordered by (start, upstream id); the open observed one is still working.
    const lane = now.unattributed!.blocks
    expect(lane.map((block) => block.order![1])).toEqual([5, 6])
    expect(lane.map((block) => block.state)).toEqual(['done', 'working'])
    expect(lane[1]!.provenance).toBe('partial')
    // The unattributed attempt does not make an agent "working".
    expect(now.headline.working).toBe(0)
  })

  test('hand-offs to and from the Unattributed lane carry a null agent; attempts from an earlier board are unlinked', async () => {
    seedWorld()
    withFlag(true)
    const now = NowSnapshotSchema.parse(JSON.parse((await body(`/api/now?${WINDOW}`)).text))
    const toUnknown = now.handoffs.find((handoff) => handoff.to.agentId === null)
    expect(toUnknown?.from.agentId).toBe('builder')
    expect(toUnknown?.kind).toBe('handoff')
    const old = now.lanes.flatMap((lane) => lane.blocks).find((block) => block.order?.[1] === 10)
    expect(old).toMatchObject({ taskId: null })
  })

  test('review checks are exact: a rejection is changes_requested, only the last reviewer attempt of a done task passed', async () => {
    seedWorld()
    withFlag(true)
    const now = NowSnapshotSchema.parse(JSON.parse((await body(`/api/now?${WINDOW}`)).text))
    const item = now.madeToday.find((entry) => entry.title === 'Done work')!
    expect(item.checks.map((check) => check.verdict)).toEqual(['changes_requested', 'passed'])
    expect(item.checks.every((check) => check.agentId === 'reviewer')).toBe(true)
  })

  test('a completed review followed by more work is unknown, never passed', async () => {
    seedWorld()
    db.tx((sqlite) =>
      seedAttempt(sqlite, { attempt: 11, task: 't-done', start: at('11:50'), end: at('11:55') }),
    )
    withFlag(true)
    const now = NowSnapshotSchema.parse(JSON.parse((await body(`/api/now?${WINDOW}`)).text))
    const item = now.madeToday.find((entry) => entry.title === 'Done work')!
    expect(item.checks.map((check) => check.verdict)).toEqual(['changes_requested', 'unknown'])
  })
})
