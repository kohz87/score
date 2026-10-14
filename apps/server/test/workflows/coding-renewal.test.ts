import { afterEach, describe, expect, test, vi } from 'vitest'
import { addCodingAgent, startWorkflow, wfRunOf } from '../helpers/wf-coding.ts'
import { workerHarness, type WorkerHarness } from '../helpers/worker-harness.ts'
import { agent, definition, edge, end } from './wf-harness.ts'

// 7.7c-1 #8 (design §4 W4, X1, X2): a coding dispatch held back 20 times is a Needs-you item, never an automatic replacement.
// Try again renews it: a fresh attempt on the same step, the reservation transferred, no execution retry spent, bounded.

vi.setConfig({ testTimeout: 180_000, hookTimeout: 30_000 })
let h: WorkerHarness
let fence: string | null = null
afterEach(async () => {
  await h?.close()
  h = undefined as never
  fence = null
})

const rows = (sql: string, ...args: (string | number)[]) =>
  h.rows<Record<string, unknown>>(sql, ...args)
const node = (id: string, nodeId: string) =>
  wfRunOf(h, id).nodeStates.find((n) => n.nodeId === nodeId)!
const revision = (id: string) => h.orch.workflowSummary(id).revision
const flow = (over: Parameters<typeof agent>[1] = {}) =>
  definition(
    [
      agent('a', {
        agentId: 'cc',
        instruction: '[fixture:basic] write hello',
        retries: 0,
        ...over,
      }),
      end(),
    ],
    [edge('a', 'done')],
  )
async function boot(options: Parameters<typeof workerHarness>[0] = {}): Promise<void> {
  h = await workerHarness({
    unit: { blocked: () => fence },
    orchestrator: { retryMs: 20 },
    ...options,
  })
  addCodingAgent(h, 'cc', 'claude-code')
}
const heldBack = () =>
  h.until(() => rows("SELECT 1 FROM orc_steps WHERE disposition = 'held_back'").length > 0, 120_000)
const tryAgain = (id: string) =>
  h.orch.wfTryAgain(id, 'a', {
    expectedNodeRevision: node(id, 'a').revision,
    orchestrationRevision: revision(id),
  })
const attempts = () =>
  rows(
    "SELECT id, n, state, suspended, reserved_usd, dispatch_generation FROM orc_attempts WHERE kind = 'step' ORDER BY n",
  )

describe('a coding dispatch held back 20 times', () => {
  test('is a Needs-you item and the planner never replaces it', async () => {
    await boot()
    const id = await startWorkflow(h, flow())
    fence = 'A fence is up.'
    await heldBack()
    expect(rows('SELECT generation FROM orc_generations')).toHaveLength(20)
    expect(node(id, 'a')).toMatchObject({ state: 'running', waitingFor: 'held_back', renewals: 0 })
    expect(h.orch.workflowSummary(id).needsYou).toContainEqual({
      kind: 'coding_held_back',
      nodeId: 'a',
    })
    // Something unrelated changes admission; the planner passes that follow create nothing (no replacement step).
    for (let i = 0; i < 3; i++) {
      await h.orch.admissionChanged()
      await h.orch.idle()
    }
    expect(rows('SELECT COUNT(*) AS n FROM orc_steps')[0]!['n']).toBe(1)
    expect(attempts()).toHaveLength(1)
    expect(attempts()[0]).toMatchObject({ suspended: 1, state: 'created' })
    expect(node(id, 'a').attemptsUsed).toBe(1)
  })

  test('Try again renews it: a fresh attempt, the reservation transferred, no retry spent (a zero-retry node can renew)', async () => {
    await boot()
    const id = await startWorkflow(h, flow(), { budgetUsd: 5 })
    fence = 'A fence is up.'
    await heldBack()
    const before = wfRunOf(h, id)
    expect(node(id, 'a')).toMatchObject({ attemptsUsed: 1, attemptsMax: 1 })
    const [first] = attempts()
    expect(before.budget.reservedUsd).toBe(0.5)
    fence = null
    await tryAgain(id)
    await h.until(() => wfRunOf(h, id).status === 'succeeded', 60_000)
    const [old, fresh] = attempts()
    expect(attempts()).toHaveLength(2)
    expect(old).toMatchObject({ id: first!['id'], state: 'refused', reserved_usd: 0 })
    expect(fresh).toMatchObject({ n: 2, state: 'terminated', dispatch_generation: 1 })
    // The same step; the node used one try of one, and one renewal.
    expect(node(id, 'a')).toMatchObject({
      attemptsUsed: 1,
      attemptsMax: 1,
      renewals: 1,
      state: 'succeeded',
    })
    expect(rows('SELECT COUNT(*) AS n FROM orc_steps')[0]!['n']).toBe(1)
    // Its own generation identities: nothing of the old 20 was reused.
    expect(
      rows(
        'SELECT attempt_id, generation FROM orc_generations WHERE attempt_id = ?',
        fresh!['id'] as string,
      ),
    ).toEqual([{ attempt_id: fresh!['id'], generation: 1 }])
    expect(rows('SELECT DISTINCT launch_id FROM orc_generations')).toHaveLength(21)
    expect(h.cliCalls()).toHaveLength(1)
    expect(h.errors).toEqual([])
  })

  test('the renewal keeps the step’s approved gate: no second approval is asked for', async () => {
    await boot()
    const id = await startWorkflow(h, flow(), { gatePolicy: 'every-step' })
    await h.until(() => wfRunOf(h, id).assignmentGates.some((g) => g.status === 'open'))
    fence = 'A fence is up.'
    const gate = wfRunOf(h, id).assignmentGates.find((g) => g.status === 'open')!
    await h.orch.wfGateDecision(id, gate.id, {
      decision: 'approve',
      expectedRevision: gate.revision,
      orchestrationRevision: revision(id),
    })
    await heldBack()
    fence = null
    await tryAgain(id)
    await h.until(() => wfRunOf(h, id).status === 'succeeded', 60_000)
    // One gate, approved once; the fresh attempt carried the step’s policy binding.
    expect(wfRunOf(h, id).assignmentGates.map((g) => g.status)).toEqual(['approved'])
    expect(attempts()).toHaveLength(2)
    expect(
      rows("SELECT policy_id FROM orc_attempts WHERE kind = 'step' ORDER BY n").map(
        (a) => a['policy_id'],
      ),
    ).toEqual([
      rows('SELECT policy_id FROM orc_worker_policies')[0]!['policy_id'],
      rows('SELECT policy_id FROM orc_worker_policies')[0]!['policy_id'],
    ])
  })

  test('renewals are bounded: after the last one is held back again the node fails “kept being held back”', async () => {
    await boot()
    const id = await startWorkflow(h, flow())
    fence = 'A fence is up.'
    for (let renewal = 0; renewal < 3; renewal++) {
      await h.until(
        () =>
          node(id, 'a').waitingFor === 'held_back' &&
          h.orch.workflowSummary(id).needsYou.some((i) => i.kind === 'coding_held_back'),
        120_000,
      )
      expect(node(id, 'a').renewals).toBe(renewal)
      await tryAgain(id)
    }
    await h.until(() => wfRunOf(h, id).status === 'failed', 120_000)
    expect(node(id, 'a')).toMatchObject({
      state: 'failed',
      reason: 'kept being held back',
      renewals: 3,
      attemptsUsed: 1,
    })
    expect(h.orch.workflowSummary(id).needsYou.some((i) => i.kind === 'coding_held_back')).toBe(
      false,
    )
    expect(h.cliCalls()).toHaveLength(0)
    // Every attempt that never started is closed: no reservation outlives the node.
    expect(attempts().every((a) => a['state'] === 'refused')).toBe(true)
    expect(attempts()).toHaveLength(4)
  })

  test('twenty readiness refusals ask for the person too; Try again renews instead of resetting the counters', async () => {
    let cause: string | undefined = 'cli_missing'
    await boot({ orchestrator: { retryMs: 20, releaseChecks: { limits: () => cause } } })
    const id = await startWorkflow(h, flow())
    // Wake the attempt out of each five-in-a-row wait until the lifetime limit asks for the person.
    const asking = () =>
      h.orch.workflowSummary(id).needsYou.some((item) => item.kind === 'coding_held_back')
    for (let i = 0; i < 60 && !asking(); i++) {
      await new Promise((resolve) => setTimeout(resolve, 500))
      await h.orch.agentReady('cc')
      await h.orch.idle()
    }
    expect(asking()).toBe(true)
    cause = undefined
    const [first] = attempts()
    expect(first).toMatchObject({ dispatch_generation: 20 })
    await tryAgain(id)
    await h.until(() => wfRunOf(h, id).status === 'succeeded', 60_000)
    expect(attempts().map((a) => a['state'])).toEqual(['refused', 'terminated'])
    expect(node(id, 'a')).toMatchObject({ attemptsUsed: 1, renewals: 1 })
  })

  test('F1 #4: readiness refusals are bounded by the same renewals: after the last one the node fails and frees its slot and reservation', async () => {
    await boot({ orchestrator: { retryMs: 20, releaseChecks: { limits: () => 'cli_missing' } } })
    const id = await startWorkflow(h, flow(), { budgetUsd: 5 })
    const asking = () =>
      h.orch.workflowSummary(id).needsYou.some((item) => item.kind === 'coding_held_back')
    const wake = async (until: () => boolean) => {
      for (let i = 0; i < 400 && !until(); i++) {
        await new Promise((resolve) => setTimeout(resolve, 40))
        await h.orch.agentReady('cc')
        await h.orch.idle()
      }
      expect(until()).toBe(true)
    }
    for (let renewal = 0; renewal < 3; renewal++) {
      await wake(asking)
      expect(node(id, 'a')).toMatchObject({ waitingFor: 'held_back', renewals: renewal })
      expect(attempts().at(-1)).toMatchObject({ state: 'created', suspended: 1 })
      await tryAgain(id)
    }
    // The fourth round of refusals: the node fails instead of asking again.
    await wake(() => wfRunOf(h, id).status === 'failed')
    expect(node(id, 'a')).toMatchObject({ state: 'failed', renewals: 3 })
    expect(h.orch.workflowSummary(id).needsYou.some((i) => i.kind === 'coding_held_back')).toBe(
      false,
    )
    expect(attempts().every((a) => a['state'] === 'refused')).toBe(true)
    expect(wfRunOf(h, id).budget.reservedUsd).toBe(0)
    expect(
      rows(
        "SELECT COUNT(*) AS n FROM orc_attempts WHERE state IN ('created', 'send_started', 'running')",
      )[0]!['n'],
    ).toBe(0)
  })
})
