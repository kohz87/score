import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { LeadScript } from '../../src/hermes/fake/fake-lead.ts'
import { workerHarness, type WorkerHarness } from '../helpers/worker-harness.ts'

// 7.7b-2 §12a: "Use the new settings" (a policy-only remap of the same agent), gates bound to the policy id, one suspended
// attempt per step re-admitted by normal admission, and the budget reservation kept through all of it.

vi.setConfig({ testTimeout: 90_000, hookTimeout: 30_000 })

let h: WorkerHarness
afterEach(async () => {
  await h?.close()
  h = undefined as never
})

const plan =
  (agents: string[]): LeadScript =>
  async (t) => {
    if (t.steps.length === 0) {
      for (const agent of agents)
        await t.call('orch.assign', { agent, instruction: '[fixture:basic] write hello' })
      return 'assigned'
    }
    if (t.steps.every((s) => s.status === 'succeeded')) {
      await t.call('orch.finish', { outcome: 'success', summary: 'done' })
      return 'done'
    }
    return 'waiting'
  }
const stepAttempts = () =>
  h.rows<Record<string, unknown>>("SELECT * FROM orc_attempts WHERE kind = 'step' ORDER BY n, id")
const stepOf = (id: string) =>
  h.rows<{ id: string; status: string; disposition: string | null }>(
    'SELECT id, status, disposition FROM orc_steps WHERE id = ?',
    id,
  )[0]!
const gens = () => h.rows<Record<string, unknown>>('SELECT * FROM orc_generations')
const revision = (id: string) => h.orch.summary(id).revision
const gate = (id: string, stepId: string) =>
  h.orch
    .snapshot(id)
    .orchestration.gates.findLast((g) => g.stepId === stepId && g.status !== 'withdrawn')!
const approve = async (id: string, stepId: string) => {
  const g = gate(id, stepId)
  await h.orch.gateDecision(id, g.id, {
    decision: 'approve',
    expectedRevision: g.revision,
    orchestrationRevision: revision(id),
  })
}
const currentPolicy = async (agent: string) =>
  (await h.orch.preflight('lead', [agent])).workers[0]!.policyId!
const storedPolicy = () =>
  h.rows<{ policy_id: string; agent_id: string }>(
    'SELECT policy_id, agent_id FROM orc_worker_policies',
  )
/** The agent's settings change while the run's step is being armed (a CLAUDE.md shows up in the workspace). */
function changeSettingsAtArming(): void {
  h.fake.hooks.afterStart = () => {
    h.fake.hooks.afterStart = undefined
    writeFileSync(join(h.workspace, 'CLAUDE.md'), 'new instructions')
  }
}

describe('Use the new settings', () => {
  test('under every-step approval: the old approval is withdrawn, a fresh one is needed, then the same attempt runs', async () => {
    h = await workerHarness({ lead: { script: plan(['coder']) } })
    h.addAgent()
    const id = await h.create({ gatePolicy: 'every-step' })
    await h.until(() => gate(id, 's1')?.status === 'open')
    const oldPolicy = storedPolicy()[0]!.policy_id
    // The gate was opened for the policy the person approved the run with.
    expect(gate(id, 's1').payload.policyId).toBe(oldPolicy)
    changeSettingsAtArming()
    await approve(id, 's1')
    await h.until(() => stepOf('s1').status === 'blocked')
    expect(stepOf('s1')).toMatchObject({ status: 'blocked', disposition: 'agent_changed' })
    const [original] = stepAttempts()
    expect(original).toMatchObject({ suspended: 1, state: 'created' })
    const fresh = await currentPolicy('coder')
    expect(fresh).not.toBe(oldPolicy)
    // The decision names the id the person saw: another id is refused, and so is a repeat of the stored one.
    await expect(
      h.orch.policyRemap(id, 's1', {
        agentId: 'coder',
        policyId: 'c'.repeat(64),
        orchestrationRevision: revision(id),
      }),
    ).rejects.toMatchObject({ status: 409, code: 'policy_changed' })
    await expect(
      h.orch.policyRemap(id, 's1', {
        agentId: 'coder',
        policyId: fresh,
        orchestrationRevision: revision(id) + 5,
      }),
    ).rejects.toMatchObject({ status: 409, code: 'conflict' })
    await h.orch.policyRemap(id, 's1', {
      agentId: 'coder',
      policyId: fresh,
      orchestrationRevision: revision(id),
    })
    expect(storedPolicy()[0]!.policy_id).toBe(fresh)
    // The old approval no longer covers the step: it waits for a new one and nothing is sent meanwhile.
    expect(stepOf('s1').status).toBe('pending_gate')
    expect(h.orch.snapshot(id).orchestration.gates.filter((g) => g.stepId === 's1')).toMatchObject([
      { status: 'withdrawn' },
      { status: 'open', payload: { policyId: fresh } },
    ])
    await h.orch.admissionChanged()
    await h.orch.idle()
    expect(gens()).toHaveLength(1)
    expect(h.cliCalls()).toHaveLength(0)
    expect(stepAttempts()).toHaveLength(1)
    await approve(id, 's1')
    await h.until(() => h.orch.summary(id).status === 'succeeded', 60_000)
    // The SAME attempt went on: one attempt for the step, two generations (the revoked one and the run).
    expect(stepAttempts().map((a) => a['id'])).toEqual([original!['id']])
    expect(stepAttempts()[0]).toMatchObject({ suspended: 0, policy_id: fresh, state: 'terminated' })
    expect(gens()).toHaveLength(2)
    expect(h.cliCalls()).toHaveLength(1)
    expect(h.errors).toEqual([])
  })

  test('without gates the step is queued again and the same attempt runs', async () => {
    h = await workerHarness({ lead: { script: plan(['coder']) } })
    h.addAgent()
    changeSettingsAtArming()
    const id = await h.create({ gatePolicy: 'none' })
    await h.until(() => stepOf('s1').status === 'blocked')
    const original = stepAttempts()[0]!['id']
    await h.orch.policyRemap(id, 's1', {
      agentId: 'coder',
      policyId: await currentPolicy('coder'),
      orchestrationRevision: revision(id),
    })
    await h.until(() => h.orch.summary(id).status === 'succeeded', 60_000)
    expect(stepAttempts().map((a) => a['id'])).toEqual([original])
  })

  test('the remap is journaled and verified after a restore', async () => {
    h = await workerHarness({ lead: { script: plan(['coder']) } })
    h.addAgent()
    changeSettingsAtArming()
    const id = await h.create({ gatePolicy: 'none' })
    await h.until(() => stepOf('s1').status === 'blocked')
    await h.orch.policyRemap(id, 's1', {
      agentId: 'coder',
      policyId: await currentPolicy('coder'),
      orchestrationRevision: revision(id),
    })
    await h.until(() => h.orch.summary(id).status === 'succeeded', 60_000)
    const read = h.journal.readOwn()
    if (!read.ok) throw new Error(read.reason)
    expect(read.entries.filter((e) => e.kind === 'policy_remap')).toMatchObject([
      { orchestrationId: id, stepId: 's1', agentId: 'coder' },
    ])
    // A database that lost the decision (older settings) is caught at the next start.
    h.db.sqlite.exec("UPDATE orc_worker_policies SET policy_id = '" + 'd'.repeat(64) + "'")
    await h.restart()
    expect(h.fence.view().fenced).toBe(true)
    expect(JSON.stringify(h.fence.view().items)).toContain(
      'were approved, but the database does not hold them',
    )
  })

  test('a reach beyond the workspace needs the acknowledgement of the new id', async () => {
    h = await workerHarness({ lead: { script: plan(['cx']) } })
    h.addAgent('cx', 'codex', 'read-only')
    h.fake.hooks.afterStart = () => {
      h.fake.hooks.afterStart = undefined
      mkdirSync(join(h.home, '.codex'), { recursive: true })
      writeFileSync(join(h.home, '.codex', 'config.toml'), 'x = 1\n')
    }
    const id = await h.create({ allowedAgents: ['cx'], gatePolicy: 'none' })
    await h.until(() => stepOf('s1').status === 'blocked')
    const fresh = await currentPolicy('cx')
    await expect(
      h.orch.policyRemap(id, 's1', {
        agentId: 'cx',
        policyId: fresh,
        orchestrationRevision: revision(id),
      }),
    ).rejects.toMatchObject({ status: 409, code: 'reach_not_acknowledged' })
    // An acknowledgement of the OLD id never carries over.
    const old = storedPolicy()[0]!.policy_id
    await expect(
      h.orch.policyRemap(id, 's1', {
        agentId: 'cx',
        policyId: fresh,
        acknowledgeCodingReach: { policyIds: [old] },
        orchestrationRevision: revision(id),
      }),
    ).rejects.toMatchObject({ code: 'reach_not_acknowledged' })
    await h.orch.policyRemap(id, 's1', {
      agentId: 'cx',
      policyId: fresh,
      acknowledgeCodingReach: { policyIds: [fresh] },
      orchestrationRevision: revision(id),
    })
    await h.until(() => h.orch.summary(id).status === 'succeeded', 60_000)
    const acks = h.rows<{ detail: string }>(
      "SELECT detail FROM orc_history WHERE kind = 'coding_reach_acknowledged' ORDER BY id",
    )
    expect(acks.map((a) => JSON.parse(a.detail).policyIds)).toEqual([[old], [fresh]])
  })

  test('only a step blocked "agent changed" with its agent can be remapped', async () => {
    h = await workerHarness({ lead: { script: plan(['coder']) } })
    h.addAgent()
    const id = await h.create({ gatePolicy: 'none' })
    await h.until(() => h.orch.summary(id).status === 'succeeded', 60_000)
    await expect(
      h.orch.policyRemap(id, 's1', {
        agentId: 'coder',
        policyId: await currentPolicy('coder'),
        orchestrationRevision: revision(id),
      }),
    ).rejects.toMatchObject({ status: 409 })
  })
})

describe('while a step waits for new settings', () => {
  test('with one slot, the suspended attempt frees it for another step', async () => {
    h = await workerHarness({ lead: { script: plan(['coder', 'cx']) } })
    h.addAgent()
    h.addAgent('cx', 'codex', 'read-only')
    changeSettingsAtArming()
    const id = await h.create({
      allowedAgents: ['coder', 'cx'],
      gatePolicy: 'none',
      maxConcurrentSteps: 1,
    })
    await h.until(() => stepOf('s1').status === 'blocked')
    await h.until(() => stepOf('s2').status === 'succeeded', 60_000)
    expect(stepOf('s1')).toMatchObject({ status: 'blocked', disposition: 'agent_changed' })
    expect(h.orch.summary(id).status).toBe('running')
  })

  test('a tight budget: the suspended attempt keeps its reservation, also across a restart', async () => {
    h = await workerHarness({ lead: { script: plan(['coder']) } })
    h.addAgent()
    changeSettingsAtArming()
    // 0.6 covers one step (0.5) and nothing more: the step's estimate must not be counted twice.
    const id = await h.create({ gatePolicy: 'none', budgetUsd: 0.6, leadTurnEstimateUsd: 0.05 })
    await h.until(() => stepOf('s1').status === 'blocked')
    const before = h.orch.snapshot(id).orchestration.budget
    await h.restart()
    const after = h.orch.snapshot(id).orchestration.budget
    expect(after.reservedUsd).toBe(before.reservedUsd)
    expect(after.remainingUsd).toBe(before.remainingUsd)
    expect(after.remainingUsd).toBeGreaterThanOrEqual(0)
    await h.orch.policyRemap(id, 's1', {
      agentId: 'coder',
      policyId: await currentPolicy('coder'),
      orchestrationRevision: revision(id),
    })
    await h.until(() => h.orch.summary(id).status === 'succeeded', 60_000)
    expect(h.orch.summary(id).pauseReason).toBeNull()
  })
})
