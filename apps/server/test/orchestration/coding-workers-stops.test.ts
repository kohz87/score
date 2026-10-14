import { afterEach, describe, expect, test, vi } from 'vitest'
import { byTurn } from '../../src/hermes/fake/fake-lead.ts'
import { workerHarness, type WorkerHarness } from '../helpers/worker-harness.ts'

// 7.7b-2 #0c (design §9): decision 74 extends to executor-owned runs, and a deadline that comes while a coding step runs
// owes it a Stop. Real executor, runtime, supervisor and journal; only systemd is faked.

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 })

let h: WorkerHarness
afterEach(async () => {
  await h?.close()
  h = undefined as never
})

const slowStep = byTurn({
  1: async (t) => {
    await t.call('orch.assign', { agent: 'coder', instruction: '[fixture:slow] stay busy' })
    return 'assigned'
  },
  2: async () => 'waiting',
})
const attempt = () =>
  h.rows<Record<string, unknown>>("SELECT * FROM orc_attempts WHERE kind = 'step' ORDER BY n")[0]!
const runs = () => h.rows<Record<string, unknown>>("SELECT * FROM runs WHERE runtime != 'hermes'")

describe('frozen home: a Stop for a run this process launched and is connected to is delivered', () => {
  test("the person's Stop of a running coding step ends it while Score is frozen", async () => {
    h = await workerHarness({ lead: { script: slowStep } })
    h.addAgent()
    const id = await h.create()
    await h.until(() => attempt()?.['state'] === 'running' && h.cliCalls().length === 1, 40_000)
    h.fence.freeze('test freeze')
    expect(h.fence.executionFrozen()).not.toBeNull()
    await h.orch.stop(id)
    await h.until(() => attempt()['stop_acknowledged_at'] !== null, 40_000)
    await h.until(() => runs()[0]?.['status'] === 'cancelled', 40_000)
    expect(attempt()['stop_requested_at']).not.toBeNull()
  })

  test('a recovered run (not started by this process) waits: no Stop is delivered while frozen', async () => {
    h = await workerHarness({ lead: { script: slowStep } })
    h.addAgent()
    const id = await h.create()
    await h.until(() => attempt()?.['state'] === 'running' && h.cliCalls().length === 1, 40_000)
    h.fence.freeze('test freeze')
    // A new process: the run is inherited (recovered), not owned.
    await h.restart()
    await h.orch.stop(id)
    await h.orch.idle()
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(attempt()['stop_acknowledged_at']).toBeNull()
    expect(h.errors).toEqual([])
  })
})

describe('deadline while a coding step runs', () => {
  test('the deadline flow owes the running step a Stop and the run ends stopped', async () => {
    h = await workerHarness({ lead: { script: slowStep } })
    h.addAgent()
    const id = await h.create({ deadlineAt: new Date(Date.now() + 3_600_000).toISOString() })
    await h.until(() => attempt()?.['state'] === 'running' && h.cliCalls().length === 1, 40_000)
    // The deadline moves earlier, to a moment that has already passed.
    h.db.sqlite
      .prepare('UPDATE orchestrations SET deadline_at = ?')
      .run(new Date(Date.now() - 1000).toISOString())
    await h.orch.admissionChanged()
    await h.until(() => attempt()['stop_requested_at'] !== null, 40_000)
    await h.until(() => runs()[0]?.['status'] === 'cancelled', 40_000)
    await h.until(() => h.orch.summary(id).status !== 'running', 40_000)
    expect(h.errors).toEqual([])
  })
})
