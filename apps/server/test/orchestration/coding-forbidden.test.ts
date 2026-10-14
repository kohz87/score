import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { byTurn } from '../../src/hermes/fake/fake-lead.ts'
import { addCodingAgent, startWorkflow, wfRunOf } from '../helpers/wf-coding.ts'
import { workerHarness, type WorkerHarness } from '../helpers/worker-harness.ts'
import { agent, definition, edge, end } from '../workflows/wf-harness.ts'

// 7.7c F1 #1: a remap never carries a coding worker to `full` access, and a stored policy with a forbidden permission is
// refused at the release (orchestrations and workflow nodes alike).

vi.setConfig({ testTimeout: 90_000, hookTimeout: 30_000 })
let h: WorkerHarness
afterEach(async () => {
  await h?.close()
  h = undefined as never
})

const assignOnly = byTurn({
  1: async (t) => {
    await t.call('orch.assign', { agent: 'coder', instruction: '[fixture:basic] write hello' })
    return 'assigned'
  },
  2: async () => 'waiting',
  3: async () => 'waiting',
})
const sql = (text: string, ...args: (string | number | null)[]) =>
  h.db.sqlite.prepare(text).run(...args)
const stepOf = () =>
  h.rows<{ status: string; disposition: string | null }>(
    'SELECT status, disposition FROM orc_steps',
  )[0]
const changeSettingsAtArming = (file: string): void => {
  h.fake.hooks.afterStart = () => {
    h.fake.hooks.afterStart = undefined
    writeFileSync(file, 'new instructions')
  }
}
const noDangerousLaunch = () => {
  for (const call of h.cliCalls()) {
    expect(call.args).not.toContain('bypassPermissions')
    expect(call.args).not.toContain('danger-full-access')
  }
}

describe('a remap never reaches full access', () => {
  test('orchestration: "Use the new settings" after the agent became full is refused and nothing launches', async () => {
    h = await workerHarness({ lead: { script: assignOnly } })
    h.addAgent()
    changeSettingsAtArming(join(h.workspace, 'CLAUDE.md'))
    const id = await h.create({ gatePolicy: 'none' })
    await h.until(() => stepOf()?.status === 'blocked')
    sql("UPDATE coding_agents SET permission = 'full' WHERE id = 'coder'")
    const report = await h.coding.workerFacts().report('coder')
    // Preflight refuses a full agent, but a client can still send the id the CLI would have now.
    expect(report.policyId).not.toBeNull()
    const policyId = report.policyId!
    await expect(
      h.orch.policyRemap(id, 's1', {
        agentId: 'coder',
        policyId,
        orchestrationRevision: h.orch.summary(id).revision,
      }),
    ).rejects.toMatchObject({ status: 422, code: 'unsupported_agent' })
    expect(stepOf()).toMatchObject({ status: 'blocked', disposition: 'agent_changed' })
    await h.orch.admissionChanged()
    await h.orch.idle()
    expect(h.cliCalls()).toHaveLength(0)
    noDangerousLaunch()
  })

  test('workflow node: the same refusal through the node policy-remap', async () => {
    h = await workerHarness()
    addCodingAgent(h, 'cc', 'claude-code')
    changeSettingsAtArming(join(h.dir, 'ws-cc', 'CLAUDE.md'))
    const id = await startWorkflow(
      h,
      definition(
        [agent('a', { agentId: 'cc', instruction: '[fixture:basic] write hello' }), end()],
        [edge('a', 'done')],
      ),
      {},
    )
    await h.until(
      () =>
        h.rows("SELECT 1 FROM orc_steps WHERE status = 'blocked' AND disposition = 'agent_changed'")
          .length > 0,
      60_000,
    )
    sql("UPDATE coding_agents SET permission = 'full' WHERE id = 'cc'")
    const report = await h.coding.workerFacts().report('cc')
    const node = wfRunOf(h, id).nodeStates.find((n) => n.nodeId === 'a')!
    await expect(
      h.orch.wfPolicyRemap(id, 'a', {
        policyId: report.policyId!,
        expectedNodeRevision: node.revision,
        orchestrationRevision: h.orch.workflowSummary(id).revision,
      }),
    ).rejects.toMatchObject({ status: 422, code: 'unsupported_agent' })
    await h.orch.admissionChanged()
    await h.orch.idle()
    expect(h.cliCalls()).toHaveLength(0)
    noDangerousLaunch()
  })
})

describe('the release refuses a stored policy with a forbidden permission', () => {
  test('typed permission_forbidden: the step is blocked for the person and nothing launches', async () => {
    h = await workerHarness({ lead: { script: assignOnly } })
    h.addAgent()
    // At arming the stored policy's permission is edited to full (its id stays: the attempt was prepared against it).
    h.fake.hooks.afterStart = () => {
      h.fake.hooks.afterStart = undefined
      const row = h.rows<{ policy: string }>('SELECT policy FROM orc_worker_policies')[0]!
      const policy = { ...JSON.parse(row.policy), permission: 'full' }
      sql('UPDATE orc_worker_policies SET policy = ?', JSON.stringify(policy))
    }
    const id = await h.create({ gatePolicy: 'none' })
    await h.until(() => stepOf()?.status === 'blocked')
    expect(h.rows('SELECT closed_cause FROM orc_generations')).toEqual([
      { closed_cause: 'permission_forbidden' },
    ])
    expect(stepOf()).toMatchObject({ status: 'blocked', disposition: 'permission_forbidden' })
    expect(h.orch.snapshot(id).orchestration.needsYou).toContainEqual(
      expect.objectContaining({ kind: 'policy_changed', stepId: 's1' }),
    )
    expect(h.cliCalls()).toHaveLength(0)
  })
})
