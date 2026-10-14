import { afterEach, describe, expect, test, vi } from 'vitest'
import { byTurn } from '../../src/hermes/fake/fake-lead.ts'
import { workerHarness, type WorkerHarness } from '../helpers/worker-harness.ts'

// 7.7b-3 #1 (design §9): owed Stops are tracked asynchronous jobs. The pump never awaits one, a coding Stop is
// acknowledged only by `stopped` / `not_running`, retries back off, and shutdown waits a bounded time for the jobs.

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

async function runningStep(orchestrator = {}): Promise<string> {
  h = await workerHarness({ lead: { script: slowStep }, orchestrator })
  h.addAgent()
  const id = await h.create()
  await h.until(() => attempt()?.['state'] === 'running' && h.cliCalls().length === 1, 40_000)
  return id
}

describe('Stop jobs', () => {
  test('a Stop that never answers does not hold the pump, and shutdown leaves it owed', async () => {
    const id = await runningStep({ stopDrainMs: 300 })
    const never = new Promise<never>(() => undefined)
    const stop = vi.spyOn(h.coding, 'stopRun').mockReturnValue(never)
    await h.orch.stop(id)
    await h.until(() => stop.mock.calls.length === 1)
    const pumped = await Promise.race([
      h.orch.pump().then(() => 'pumped'),
      new Promise((resolve) => setTimeout(() => resolve('blocked'), 2_000)),
    ])
    expect(pumped).toBe('pumped')
    const started = Date.now()
    await h.orch.close()
    expect(Date.now() - started).toBeLessThan(3_000)
    expect(attempt()['stop_requested_at']).not.toBeNull()
    expect(attempt()['stop_acknowledged_at']).toBeNull()
  })

  test('a coding Stop answered with anything but stopped / not_running stays owed', async () => {
    const id = await runningStep()
    const stop = vi.spyOn(h.coding, 'stopRun').mockResolvedValue(undefined as never)
    await h.orch.stop(id)
    await h.until(() => stop.mock.calls.length >= 2, 10_000)
    expect(attempt()['stop_acknowledged_at']).toBeNull()
    stop.mockResolvedValue('stopped')
    await h.until(() => attempt()['stop_acknowledged_at'] !== null, 10_000)
  })

  test('retries back off', async () => {
    const id = await runningStep()
    const times: number[] = []
    const stop = vi.spyOn(h.coding, 'stopRun').mockImplementation(async () => {
      times.push(Date.now())
      return 'unconfirmed'
    })
    await h.orch.stop(id)
    await h.until(() => stop.mock.calls.length >= 4, 20_000)
    const gaps = times.slice(1).map((t, i) => t - times[i]!)
    // retryMs is 100: the gaps are about 100, 200, 400.
    expect(gaps[2]!).toBeGreaterThan(gaps[0]! * 2)
  })
})
