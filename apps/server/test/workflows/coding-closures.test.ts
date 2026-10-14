import { afterEach, describe, expect, test, vi } from 'vitest'
import { addCodingAgent, startWorkflow, wfRunOf } from '../helpers/wf-coding.ts'
import { workerHarness, type WorkerHarness } from '../helpers/worker-harness.ts'
import { agent, definition, edge, end } from './wf-harness.ts'

// 7.7c-1 #9 (design §4 X6): every coding closure cause has a node transition. `inputs_withdrawn` leaves the node unresolved
// with its own Needs-you item (never running for ever); holds keep the node running and the attempt is admitted again;
// Stop and the deadline keep the run's terminal behaviour.

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
const needs = (id: string) => h.orch.workflowSummary(id).needsYou
const chain = () =>
  definition(
    [
      agent('a', { agentId: 'cc', instruction: '[fixture:basic] first' }),
      agent('b', { agentId: 'cc', instruction: 'Continue from {{nodes.a.output}}' }),
      end(),
    ],
    [edge('a', 'b'), edge('b', 'done')],
  )
async function boot(): Promise<void> {
  h = await workerHarness()
  addCodingAgent(h, 'cc', 'claude-code')
}
/** Runs `change` while the second coding unit (the consumer's) is being armed, before its release decision. */
function atSecondArming(change: () => void): void {
  let starts = 0
  h.fake.hooks.afterStart = () => {
    if (++starts < 2) return
    h.fake.hooks.afterStart = undefined
    change()
  }
}
const withdrawInputsOfB = () =>
  h.db.sqlite.prepare("UPDATE wf_consumed SET withdrawn = 1 WHERE consumer = 'b'").run()
const retry = (id: string, nodeId: string) =>
  h.orch.wfRetry(id, nodeId, {
    expectedNodeRevision: node(id, nodeId).revision,
    orchestrationRevision: revision(id),
    acknowledge: true,
  })

describe('inputs withdrawn', () => {
  test('while the consumer is arming: the node is unresolved with its own item, and can be retried even with no retries', async () => {
    await boot()
    atSecondArming(withdrawInputsOfB)
    const id = await startWorkflow(h, chain())
    await h.until(() => node(id, 'b').state === 'unresolved', 60_000)
    expect(node(id, 'b')).toMatchObject({ state: 'unresolved', attemptsUsed: 0, canRetry: true })
    expect(needs(id)).toContainEqual({ kind: 'node_inputs_withdrawn', nodeId: 'b' })
    expect(needs(id).some((item) => item.kind === 'retry' && item.nodeId === 'b')).toBe(false)
    // Nothing of b ever ran: one CLI process so far (a's), and no reservation is held.
    expect(h.cliCalls()).toHaveLength(1)
    expect(wfRunOf(h, id).budget.reservedUsd).toBe(0)
    await retry(id, 'b')
    await h.until(() => wfRunOf(h, id).status === 'succeeded', 60_000)
    expect(h.cliCalls()).toHaveLength(2)
    expect(node(id, 'b')).toMatchObject({ state: 'succeeded', attemptsUsed: 1 })
  })

  test('while the consumer is queued behind its approval: the same node transition and item', async () => {
    await boot()
    const id = await startWorkflow(h, chain(), { gatePolicy: 'every-step' })
    const approveOpen = async () => {
      await h.until(() => wfRunOf(h, id).assignmentGates.some((g) => g.status === 'open'))
      const gate = wfRunOf(h, id).assignmentGates.find((g) => g.status === 'open')!
      await h.orch.wfGateDecision(id, gate.id, {
        decision: 'approve',
        expectedRevision: gate.revision,
        orchestrationRevision: revision(id),
      })
      return gate
    }
    await approveOpen()
    await h.until(
      () => wfRunOf(h, id).assignmentGates.some((g) => g.nodeId === 'b' && g.status === 'open'),
      60_000,
    )
    withdrawInputsOfB()
    await approveOpen()
    await h.until(() => node(id, 'b').state === 'unresolved', 60_000)
    expect(needs(id)).toContainEqual({ kind: 'node_inputs_withdrawn', nodeId: 'b' })
    expect(node(id, 'b').attemptsUsed).toBe(0)
    expect(h.cliCalls()).toHaveLength(1)
  })
})

describe('holds, Stop and the deadline', () => {
  test('a pause that comes while the step is arming holds the attempt: the node stays running and finishes after Resume', async () => {
    await boot()
    h.fake.hooks.afterStart = () => {
      h.fake.hooks.afterStart = undefined
      h.db.sqlite
        .prepare("UPDATE orchestrations SET manual_paused_at = ?, status = 'paused'")
        .run(new Date().toISOString())
    }
    const id = await startWorkflow(
      h,
      definition(
        [agent('a', { agentId: 'cc', instruction: '[fixture:basic] go' }), end()],
        [edge('a', 'done')],
      ),
    )
    await h.until(
      () =>
        rows('SELECT closed_cause FROM orc_generations').some(
          (g) => g['closed_cause'] === 'paused',
        ),
      60_000,
    )
    expect(node(id, 'a').state).toBe('running')
    expect(rows("SELECT state, suspended FROM orc_attempts WHERE kind = 'step'")).toEqual([
      { state: 'created', suspended: 0 },
    ])
    await h.orch.wfResume(id, { orchestrationRevision: revision(id) })
    await h.until(() => wfRunOf(h, id).status === 'succeeded', 60_000)
    expect(rows('SELECT COUNT(*) AS n FROM orc_attempts')[0]!['n']).toBe(1)
  })

  test('Stop while the step runs ends the run stopped; its node is cancelled with it, not left running', async () => {
    await boot()
    const id = await startWorkflow(
      h,
      definition(
        [agent('a', { agentId: 'cc', instruction: '[fixture:slow] stay busy' }), end()],
        [edge('a', 'done')],
      ),
    )
    await h.until(
      () =>
        h.cliCalls().length === 1 &&
        rows("SELECT 1 FROM orc_attempts WHERE state = 'running'").length === 1,
      60_000,
    )
    await h.orch.wfStop(id)
    await h.until(() => wfRunOf(h, id).status === 'stopped', 60_000)
    expect(node(id, 'a').state).toBe('cancelled')
  })

  test('a deadline that passes while the step runs ends the run stopped; its node is cancelled', async () => {
    await boot()
    const id = await startWorkflow(
      h,
      definition(
        [agent('a', { agentId: 'cc', instruction: '[fixture:slow] stay busy' }), end()],
        [edge('a', 'done')],
      ),
      { deadlineAt: new Date(Date.now() + 3_600_000).toISOString() },
    )
    await h.until(
      () =>
        h.cliCalls().length === 1 &&
        rows("SELECT 1 FROM orc_attempts WHERE state = 'running'").length === 1,
      60_000,
    )
    h.db.sqlite
      .prepare('UPDATE orchestrations SET deadline_at = ?')
      .run(new Date(Date.now() - 1000).toISOString())
    await h.orch.admissionChanged()
    await h.until(() => wfRunOf(h, id).status === 'stopped', 60_000)
    expect(node(id, 'a').state).toBe('cancelled')
  })
})
