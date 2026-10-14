import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { addCodingAgent, startWorkflow, wfRunOf } from '../helpers/wf-coding.ts'
import { workerHarness, type WorkerHarness } from '../helpers/worker-harness.ts'
import { agent, definition, edge, end } from './wf-harness.ts'

// 7.7c F1 #2: a decision about a coding node reaches the node's CURRENT attempt, never the retired predecessor of a renewal.

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
const node = (id: string) => wfRunOf(h, id).nodeStates.find((n) => n.nodeId === 'a')!
const revision = (id: string) => h.orch.workflowSummary(id).revision
const flow = () =>
  definition(
    [agent('a', { agentId: 'cc', instruction: '[fixture:basic] write hello', retries: 0 }), end()],
    [edge('a', 'done')],
  )

describe('renewal then new settings', () => {
  test('the remap goes to the fresh attempt, which then runs; the retired predecessor is not suspended', async () => {
    h = await workerHarness({ unit: { blocked: () => fence }, orchestrator: { retryMs: 20 } })
    addCodingAgent(h, 'cc', 'claude-code')
    const id = await startWorkflow(h, flow())
    fence = 'A fence is up.'
    await h.until(
      () => rows("SELECT 1 FROM orc_steps WHERE disposition = 'held_back'").length > 0,
      120_000,
    )
    await h.orch.wfTryAgain(id, 'a', {
      expectedNodeRevision: node(id).revision,
      orchestrationRevision: revision(id),
    })
    // The agent's settings change while the renewed attempt waits; lifting the fence blocks it as `agent_changed`.
    writeFileSync(join(h.dir, 'ws-cc', 'CLAUDE.md'), 'new instructions')
    fence = null
    await h.until(
      () => rows("SELECT 1 FROM orc_steps WHERE disposition = 'agent_changed'").length > 0,
      60_000,
    )
    const [old, fresh] = rows(
      "SELECT id, suspended, state, policy_id FROM orc_attempts WHERE kind = 'step' ORDER BY n",
    )
    expect(old).toMatchObject({ state: 'refused', suspended: 0 })
    expect(fresh).toMatchObject({ state: 'created', suspended: 1 })
    const fix = (await h.orch.preflight('lead', ['cc'])).workers[0]!.policyId!
    await h.orch.wfPolicyRemap(id, 'a', {
      policyId: fix,
      expectedNodeRevision: node(id).revision,
      orchestrationRevision: revision(id),
    })
    expect(rows('SELECT policy_id FROM orc_attempts WHERE id = ?', fresh!['id'] as string)).toEqual(
      [{ policy_id: fix }],
    )
    await h.until(() => wfRunOf(h, id).status === 'succeeded', 60_000)
    expect(h.cliCalls()).toHaveLength(1)
  })
})
