import { afterEach, describe, expect, test, vi } from 'vitest'
import { saveCodingQuota } from '../../src/runtimes/coding/store.ts'
import { addCodingAgent, startWorkflow, wfRunOf } from '../helpers/wf-coding.ts'
import { workerHarness, type WorkerHarness } from '../helpers/worker-harness.ts'
import { agent, definition, edge, end } from './wf-harness.ts'

// PLAN 8.6 (decision 91) for workflows: a coding step is checked when it would start. Below the floor it waits, with its
// node keeping the step, and the same Needs-you item (no lead to re-plan); the three answers work per node.

vi.setConfig({ testTimeout: 120_000, hookTimeout: 30_000 })
let h: WorkerHarness
afterEach(async () => {
  await h?.close()
  h = undefined as never
})

const flow = () =>
  definition(
    [agent('a', { agentId: 'cc', instruction: '[fixture:basic] first' }), end()],
    [edge('a', 'done')],
  )
const low = (resetsAt = new Date(Date.now() + 3 * 3_600_000).toISOString()): void =>
  saveCodingQuota(h.db.sqlite, 'cc', {
    runtime: 'claude-code',
    seenAt: new Date().toISOString(),
    windows: [{ name: '5 hours', group: null, usedPercent: 94, resetsAt }],
    source: 'turn',
  })
const node = (id: string) => wfRunOf(h, id).nodeStates.find((n) => n.nodeId === 'a')!
const revision = (id: string) => h.orch.workflowSummary(id).revision
const holdState = () => h.rows<{ state: string }>('SELECT state FROM orc_quota_holds')[0]?.state
async function boot(): Promise<void> {
  h = await workerHarness()
  addCodingAgent(h, 'cc', 'claude-code')
}

describe('a coding step below its quota floor', () => {
  test('waits with the same Needs-you item; "Use it anyway" starts it once', async () => {
    await boot()
    low()
    const id = await startWorkflow(h, flow(), { gatePolicy: 'gates-only' })
    await h.until(() => holdState() === 'held', 60_000)
    expect(node(id)).toMatchObject({ state: 'running', waitingFor: 'quota_low' })
    expect(h.orch.workflowSummary(id).needsYou).toContainEqual(
      expect.objectContaining({
        kind: 'quota_low',
        nodeId: 'a',
        agentId: 'cc',
        window: '5 hours',
        leftPercent: 6,
      }),
    )
    // There is no lead to tell: no cause is written for it.
    expect(h.rows("SELECT 1 FROM orc_causes WHERE kind = 'step_held'")).toHaveLength(0)
    await h.orch.idle()
    expect(h.cliCalls()).toHaveLength(0)
    await h.orch.wfQuotaDecision(id, 'a', {
      answer: 'use_anyway',
      orchestrationRevision: revision(id),
    })
    await h.until(() => wfRunOf(h, id).status === 'succeeded', 60_000)
    expect(h.cliCalls()).toHaveLength(1)
    expect(h.rows("SELECT 1 FROM orc_history WHERE kind = 'quota_override'")).toHaveLength(1)
    expect(h.errors).toEqual([])
  })

  test('"Wait until it resets" goes on by itself; "Stop the run" stops it', async () => {
    await boot()
    low(new Date(Date.now() + 2_500).toISOString())
    const id = await startWorkflow(h, flow(), { gatePolicy: 'gates-only' })
    await h.until(() => holdState() === 'held', 60_000)
    await h.orch.wfQuotaDecision(id, 'a', { answer: 'wait', orchestrationRevision: revision(id) })
    expect(holdState()).toBe('waiting')
    expect(h.orch.workflowSummary(id).needsYou.some((i) => i.kind === 'quota_low')).toBe(false)
    expect(node(id).waitingFor).toBe('quota_low')
    await h.until(() => wfRunOf(h, id).status === 'succeeded', 60_000)
    expect(h.rows("SELECT 1 FROM orc_history WHERE kind = 'quota_waited'")).toHaveLength(1)

    const second = await startWorkflow(h, flow(), { gatePolicy: 'gates-only' }, {})
    // The second run starts after the first finished; its agent is low again.
    low()
    await h.until(
      () => h.rows('SELECT 1 FROM orc_quota_holds WHERE orchestration_id = ?', second).length > 0,
      60_000,
    )
    await h.orch.wfQuotaDecision(second, 'a', {
      answer: 'stop',
      orchestrationRevision: revision(second),
    })
    await h.until(() => wfRunOf(h, second).status === 'stopped', 60_000)
  })

  test('a run floor of 5 lets a step with 6% left start, and the floor can be changed in the limits', async () => {
    await boot()
    low()
    const id = await startWorkflow(h, flow(), { quotaFloorPercent: 5 })
    await h.until(() => wfRunOf(h, id).status === 'succeeded', 60_000)
    expect(holdState()).toBeUndefined()
    expect(wfRunOf(h, id).coding?.quotaFloorPercent).toBe(5)

    // The finished turn stored the CLI's own reading: low again.
    low()
    const held = await startWorkflow(h, flow(), { gatePolicy: 'gates-only' })
    await h.until(() => holdState() === 'held', 60_000)
    await h.orch.wfLimits(held, { quotaFloorPercent: 5, orchestrationRevision: revision(held) })
    await h.until(() => wfRunOf(h, held).status === 'succeeded', 60_000)
    expect(h.errors).toEqual([])
  })

  test('a missing reading never holds a step', async () => {
    await boot()
    const id = await startWorkflow(h, flow(), { gatePolicy: 'gates-only' })
    await h.until(() => wfRunOf(h, id).status === 'succeeded', 60_000)
    expect(holdState()).toBeUndefined()
  })
})
