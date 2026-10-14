import { afterEach, describe, expect, test, vi } from 'vitest'
import { addCodingAgent, startWorkflow, wfRunOf } from '../helpers/wf-coding.ts'
import { workerHarness, type WorkerHarness } from '../helpers/worker-harness.ts'
import { agent, definition, edge, end, join } from './wf-harness.ts'

// 7.7c-1 #5 (design §4 W1): a coding node blocked for a decision keeps its step. Raising the coding step limit re-admits THAT
// suspended attempt: no replacement step, no second reservation, `attempts_used` unchanged, at either concurrency, with
// fan-out, a tight budget and across a restart.

vi.setConfig({ testTimeout: 120_000, hookTimeout: 30_000 })
let h: WorkerHarness
afterEach(async () => {
  await h?.close()
  h = undefined as never
})

const rows = (sql: string, ...args: (string | number)[]) =>
  h.rows<Record<string, unknown>>(sql, ...args)
const node = (id: string, nodeId: string) =>
  wfRunOf(h, id).nodeStates.find((n) => n.nodeId === nodeId)!
const revision = (id: string) => h.orch.workflowSummary(id).revision
const sequence = () =>
  definition(
    [
      agent('a', { agentId: 'cc', instruction: '[fixture:basic] first' }),
      agent('b', { agentId: 'cc', instruction: '[fixture:basic] second' }),
      end(),
    ],
    [edge('a', 'b'), edge('b', 'done')],
  )
const fanOut = () =>
  definition(
    [
      agent('a', { agentId: 'cc', instruction: '[fixture:basic] left' }),
      agent('b', { agentId: 'cc', instruction: '[fixture:basic] right' }),
      join('j'),
      end(),
    ],
    [edge('a', 'j'), edge('b', 'j'), edge('j', 'done')],
  )
async function boot(): Promise<void> {
  h = await workerHarness()
  addCodingAgent(h, 'cc', 'claude-code')
}
/** Gives the planner several passes (the periodic sweep and a new generation each time) while a step waits. */
async function passes(id: string, times = 4): Promise<void> {
  for (let i = 0; i < times; i++) {
    await h.orch.admissionChanged()
    await h.orch.idle()
  }
  expect(wfRunOf(h, id).status).not.toBe('failed')
}
// Waits on the executor's own state (the step is blocked at the limit), so the checks after it are about what the planner did.
const blocked = () =>
  h.until(
    () => rows("SELECT 1 FROM orc_steps WHERE disposition = 'coding_limit'").length > 0,
    60_000,
  )
const attemptsOf = (stepId: string) =>
  rows(
    'SELECT id, n, state, suspended, reserved_usd FROM orc_attempts WHERE step_id = ? ORDER BY n',
    stepId,
  )

describe('a coding node blocked at the step limit keeps its step', () => {
  test('concurrency 1: raising the limit resumes the same attempt; no replacement, attempts used unchanged', async () => {
    await boot()
    const id = await startWorkflow(h, sequence(), { codingSteps: 1, maxConcurrentSteps: 1 })
    await blocked()
    const held = node(id, 'b')
    expect(held).toMatchObject({
      state: 'running',
      attemptsUsed: 1,
      lineage: [held.stepId],
      waitingFor: 'coding_limit',
    })
    expect(h.orch.workflowSummary(id).needsYou).toContainEqual({
      kind: 'coding_limit',
      used: 1,
      limit: 1,
    })
    const [attempt] = attemptsOf(held.stepId!)
    expect(attempt).toMatchObject({ suspended: 1, state: 'created' })
    // The planner passes that follow (new generations, sweeps) never assign a replacement.
    await passes(id)
    expect(node(id, 'b')).toMatchObject({ stepId: held.stepId, lineage: [held.stepId] })
    expect(rows('SELECT COUNT(*) AS n FROM orc_steps')[0]!['n']).toBe(2)
    await h.orch.wfLimits(id, { codingSteps: 2, orchestrationRevision: revision(id) })
    await h.until(() => wfRunOf(h, id).status === 'succeeded', 60_000)
    expect(attemptsOf(held.stepId!).map((a) => a['id'])).toEqual([attempt!['id']])
    expect(node(id, 'b')).toMatchObject({ state: 'succeeded', attemptsUsed: 1 })
    expect(rows('SELECT COUNT(*) AS n FROM orc_steps')[0]!['n']).toBe(2)
    expect(h.cliCalls()).toHaveLength(2)
    expect(h.errors).toEqual([])
  })

  test('concurrency 2 with fan-out: the step that did not get a launch waits, then both finish once each', async () => {
    await boot()
    const id = await startWorkflow(h, fanOut(), { codingSteps: 1, maxConcurrentSteps: 2 })
    await blocked()
    const heldStep = rows("SELECT id FROM orc_steps WHERE disposition = 'coding_limit'")[0]!['id']
    const heldNode = ['a', 'b'].find((n) => node(id, n).stepId === heldStep)!
    expect(heldNode).toBeDefined()
    const step = heldStep as string
    expect(node(id, heldNode).waitingFor).toBe('coding_limit')
    await passes(id)
    expect(node(id, heldNode).stepId).toBe(step)
    expect(rows('SELECT COUNT(*) AS n FROM orc_steps')[0]!['n']).toBe(2)
    await h.orch.wfLimits(id, { codingSteps: 2, orchestrationRevision: revision(id) })
    await h.until(() => wfRunOf(h, id).status === 'succeeded', 60_000)
    expect(rows("SELECT COUNT(*) AS n FROM orc_attempts WHERE kind = 'step'")[0]!['n']).toBe(2)
    expect(
      wfRunOf(h, id)
        .nodeStates.filter((n) => n.kind === 'agent')
        .map((n) => n.attemptsUsed),
    ).toEqual([1, 1])
    expect(h.cliCalls()).toHaveLength(2)
  })

  test('a tight budget: the suspended attempt holds the only reservation; there is no second one', async () => {
    await boot()
    // The first step settles about a cent; the second reserves 0.50. A replacement step would need another 0.50.
    const id = await startWorkflow(h, sequence(), {
      codingSteps: 1,
      maxConcurrentSteps: 1,
      budgetUsd: 0.6,
    })
    await blocked()
    await passes(id)
    expect(wfRunOf(h, id).budget.reservedUsd).toBe(0.5)
    await h.orch.wfLimits(id, { codingSteps: 2, orchestrationRevision: revision(id) })
    await h.until(() => wfRunOf(h, id).status === 'succeeded', 60_000)
    expect(node(id, 'b').attemptsUsed).toBe(1)
  })

  test('across a restart: the held step is still the node’s, and the raised limit resumes it', async () => {
    await boot()
    const id = await startWorkflow(h, sequence(), { codingSteps: 1, maxConcurrentSteps: 1 })
    await blocked()
    const step = node(id, 'b').stepId!
    const [attempt] = attemptsOf(step)
    await h.restart()
    await passes(id)
    expect(node(id, 'b')).toMatchObject({ stepId: step, state: 'running' })
    expect(rows('SELECT COUNT(*) AS n FROM orc_steps')[0]!['n']).toBe(2)
    await h.orch.wfLimits(id, { codingSteps: 2, orchestrationRevision: revision(id) })
    await h.until(() => wfRunOf(h, id).status === 'succeeded', 60_000)
    expect(attemptsOf(step).map((a) => a['id'])).toEqual([attempt!['id']])
    expect(h.cliCalls()).toHaveLength(2)
  })
})
