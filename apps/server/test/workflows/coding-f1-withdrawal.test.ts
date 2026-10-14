import { afterEach, describe, expect, test, vi } from 'vitest'
import { addCodingAgent, startWorkflow, wfRunOf } from '../helpers/wf-coding.ts'
import { withdrawGraphEvidence } from '../../src/domain/workflows/withdraw.ts'
import { workerHarness, type WorkerHarness } from '../helpers/worker-harness.ts'
import { agent, definition, edge, end } from './wf-harness.ts'

// 7.7c F1 #3: a try given back after a withdrawal is consumed exactly once; `attempts_max` is never exceeded.

vi.setConfig({ testTimeout: 120_000, hookTimeout: 30_000 })
let h: WorkerHarness
let lifted = false
afterEach(async () => {
  await h?.close()
  h = undefined as never
  lifted = false
})

const node = (id: string, nodeId: string) =>
  wfRunOf(h, id).nodeStates.find((n) => n.nodeId === nodeId)!
const revision = (id: string) => h.orch.workflowSummary(id).revision

describe('withdrawn inputs of a retry', () => {
  test('after one executed failure, a withdrawn second try gives its slot back once: two executions in all', async () => {
    h = await workerHarness({
      // The fence goes up once b's first try has started: its failure is real, and the next try is held back unsent.
      unit: { blocked: () => (!lifted && h.cliCalls().length >= 2 ? 'A fence is up.' : null) },
    })
    addCodingAgent(h, 'cc', 'claude-code')
    const id = await startWorkflow(
      h,
      definition(
        [
          agent('a', { agentId: 'cc', instruction: '[fixture:basic] first' }),
          agent('b', {
            agentId: 'cc',
            instruction: '[fixture:error] go on from {{nodes.a.output}}',
            retries: 1,
          }),
          end(),
        ],
        [edge('a', 'b'), edge('b', 'done')],
      ),
    )
    // b's first try ran and failed; its second try is prepared and held back by a fence, so it is unsent.
    await h.until(
      () =>
        h.cliCalls().length === 2 && h.rows("SELECT 1 FROM orc_steps WHERE id = 's3'").length === 1,
      90_000,
    )
    // a's result is withdrawn: what b was going to read is gone (the real graph withdrawal).
    h.db.tx((sqlite) => {
      const ctx = {
        sqlite,
        now: new Date().toISOString(),
        journal: h.journal,
        touched: new Set<string>(),
        events: [],
      }
      withdrawGraphEvidence(ctx, id, 'a', 'was withdrawn')
    })
    await h.orch.admissionChanged()
    await h.until(() => node(id, 'b').state === 'unresolved', 90_000)
    expect(h.cliCalls()).toHaveLength(2)
    expect(node(id, 'b')).toMatchObject({ attemptsUsed: 1, attemptsMax: 2, canRetry: true })
    lifted = true
    await h.orch.wfRetry(id, 'b', {
      expectedNodeRevision: node(id, 'b').revision,
      orchestrationRevision: revision(id),
      acknowledge: true,
    })
    await h.until(() => wfRunOf(h, id).status !== 'running', 90_000)
    // The refunded slot was used by the retry (try 2 of 2); nothing ran a third time.
    expect(h.cliCalls()).toHaveLength(3)
    expect(node(id, 'b')).toMatchObject({ state: 'failed', attemptsUsed: 2, attemptsMax: 2 })
    expect(h.rows("SELECT COUNT(*) AS n FROM orc_steps WHERE status = 'failed'")[0]).toMatchObject({
      n: 2,
    })
  })
})
