import { afterEach, describe, expect, test, vi } from 'vitest'
import { addCodingAgent, startWorkflow, wfRunOf } from '../helpers/wf-coding.ts'
import { workerHarness, type WorkerHarness } from '../helpers/worker-harness.ts'
import { agent, definition, edge, end, join } from './wf-harness.ts'

// 7.7c F1 #6: the retained inputs of coding attempts that were prepared and not sent are reserved on their own and bounded:
// a wide fan-out with a small coding step limit never spills past the run's coding partition into the control reserve.

vi.setConfig({ testTimeout: 180_000, hookTimeout: 30_000 })
let h: WorkerHarness
afterEach(async () => {
  await h?.close()
  h = undefined as never
})

const rows = (sql: string, ...args: (string | number)[]) =>
  h.rows<Record<string, unknown>>(sql, ...args)
const revision = (id: string) => h.orch.workflowSummary(id).revision
const WIDTH = 24
// One seed step makes a large reply; 24 steps then each read it, so every prepared input is large.
const fanOut = () => {
  const names = Array.from({ length: WIDTH }, (_, i) => `n${i + 1}`)
  return definition(
    [
      agent('seed', { agentId: 'cc', instruction: '[fixture:bigreply] write a lot' }),
      ...names.map((name) =>
        agent(name, {
          agentId: 'cc',
          instruction: `[fixture:basic] ${name} {{nodes.seed.output}}`,
        }),
      ),
      join('j'),
      end(),
    ],
    [
      ...names.map((name) => edge('seed', name)),
      ...names.map((name) => edge(name, 'j')),
      edge('j', 'done'),
    ],
  )
}
const run = () =>
  rows(
    'SELECT reserve_bytes, stored_bytes, coding_reserve_bytes, coding_stored_bytes, max_steps, max_concurrent_steps FROM orchestrations',
  )[0] as {
    reserve_bytes: number
    stored_bytes: number
    coding_reserve_bytes: number
    coding_stored_bytes: number
    max_steps: number
    max_concurrent_steps: number
  }
const unsent = () =>
  Number(
    rows(
      "SELECT COUNT(*) AS n FROM orc_attempts WHERE kind = 'step' AND state = 'created' AND runtime != 'hermes'",
    )[0]!['n'],
  )

describe('unsent coding inventory', () => {
  test('a 24-node fan-out with a step limit of 1 retains a bounded number of inputs and never spills', async () => {
    h = await workerHarness()
    addCodingAgent(h, 'cc', 'claude-code')
    const id = await startWorkflow(h, fanOut(), { codingSteps: 1, maxConcurrentSteps: 2 })
    await h.until(
      () => rows("SELECT 1 FROM orc_steps WHERE disposition = 'coding_limit'").length > 0,
      90_000,
    )
    // Settled: nothing is in flight, and the planner has nothing more to admit.
    const inFlight = () =>
      rows("SELECT 1 FROM orc_attempts WHERE state IN ('send_started', 'running')").length
    let calm = 0
    for (let i = 0; i < 200 && calm < 5; i++) {
      await h.orch.admissionChanged()
      await h.orch.idle()
      await new Promise((resolve) => setTimeout(resolve, 100))
      calm = inFlight() === 0 ? calm + 1 : 0
    }
    const before = run()
    // The partition (one item plus the unsent-input room) was never exceeded: nothing went into the control reserve.
    expect(before.coding_stored_bytes).toBeLessThanOrEqual(before.coding_reserve_bytes)
    expect(before.stored_bytes).toBeLessThanOrEqual(before.reserve_bytes)
    // Two per concurrent step, and the rest of the steps waited unprepared.
    expect(unsent()).toBeLessThanOrEqual(2 * before.max_concurrent_steps)
    expect(rows('SELECT COUNT(*) AS n FROM orc_attempts')[0]!['n']).toBeLessThan(WIDTH)
    // Raising the limit grows the partition; the parked steps are prepared as room appears and the run completes.
    await h.orch.wfLimits(id, { codingSteps: WIDTH + 1, orchestrationRevision: revision(id) })
    await h.until(() => wfRunOf(h, id).status === 'succeeded', 150_000)
    const after = run()
    expect(after.coding_stored_bytes).toBeLessThanOrEqual(after.coding_reserve_bytes)
    expect(h.cliCalls()).toHaveLength(WIDTH + 1)
    expect(h.errors).toEqual([])
  })
})
