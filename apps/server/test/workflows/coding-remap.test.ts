import { afterEach, describe, expect, test, vi } from 'vitest'
import { addCodingAgent, startWorkflow, wfRunOf } from '../helpers/wf-coding.ts'
import { workerHarness, type WorkerHarness } from '../helpers/worker-harness.ts'
import { A, B, agent, definition, edge, end } from './wf-harness.ts'

// 7.7c-1 #7 (design §4 X3): the workflow remap (the same agent id, a new version) of a coding agent asks for its current
// policy and consent, closes every provably unsent attempt of the node, suspended blocked ones included (their
// reservations are released), and re-creates the work under the new version.

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
const flow = (agentId: string) =>
  definition(
    [agent('a', { agentId, instruction: '[fixture:basic] write hello' }), end()],
    [edge('a', 'done')],
  )
const lifecycle = (agentId: string, incarnation: string) =>
  h.db.sqlite
    .prepare(
      "INSERT INTO agent_lifecycle (agent_id, incarnation_id, state) VALUES (?, ?, 'ready') ON CONFLICT (agent_id) DO UPDATE SET incarnation_id = excluded.incarnation_id",
    )
    .run(agentId, incarnation)
const currentPolicy = async (agentId: string) =>
  (await h.orch.preflight('lead', [agentId])).workers[0]!.policyId!
const remapCard = (id: string, agentId: string) =>
  h.orch
    .workflowSummary(id)
    .needsYou.find((item) => item.kind === 'remap' && item.agentId === agentId)
const decision = async (id: string, agentId: string, consent: object = {}) => {
  const card = remapCard(id, agentId)
  if (card?.kind !== 'remap') throw new Error('no remap card')
  return {
    agentId,
    frozenIncarnation: card.frozenIncarnation,
    currentIncarnation: card.currentIncarnation,
    orchestrationRevision: revision(id),
    acknowledge: true as const,
    plan: card.plan.map(({ nodeId, payloadHash }) => ({ nodeId, payloadHash })),
    ...consent,
  }
}
async function boot(): Promise<void> {
  h = await workerHarness()
  addCodingAgent(h, 'cc', 'claude-code')
  addCodingAgent(h, 'cx', 'codex', 'read-only')
  lifecycle('cc', A)
  lifecycle('cx', A)
}
/** The agent is replaced while its step is being armed (just before the release decision). */
const replacedAtArming = (agentId: string) => {
  h.fake.hooks.afterStart = () => {
    h.fake.hooks.afterStart = undefined
    lifecycle(agentId, B)
  }
}

describe('remapping a coding agent’s new version', () => {
  test('a suspended blocked attempt is closed with its reservation; the node runs again under the new version', async () => {
    await boot()
    replacedAtArming('cc')
    const id = await startWorkflow(h, flow('cc'), { gatePolicy: 'every-step', budgetUsd: 5 })
    await h.until(() => wfRunOf(h, id).assignmentGates.some((g) => g.status === 'open'))
    const gate = wfRunOf(h, id).assignmentGates.find((g) => g.status === 'open')!
    await h.orch.wfGateDecision(id, gate.id, {
      decision: 'approve',
      expectedRevision: gate.revision,
      orchestrationRevision: revision(id),
    })
    await h.until(
      () => rows("SELECT 1 FROM orc_steps WHERE disposition = 'agent_changed'").length > 0,
      60_000,
    )
    const [held] = rows("SELECT id, suspended, reserved_usd FROM orc_attempts WHERE kind = 'step'")
    expect(held).toMatchObject({ suspended: 1, reserved_usd: 0.5 })
    expect(node(id, 'a')).toMatchObject({ state: 'running', waitingFor: 'coding_settings' })
    const card = remapCard(id, 'cc')
    expect(card).toMatchObject({
      kind: 'remap',
      nodeIds: ['a'],
      plan: [{ nodeId: 'a', retiresAttemptId: held!['id'] }],
    })
    // Consent first: the policy id of the new version, nothing else will do.
    await expect(h.orch.wfRemap(id, await decision(id, 'cc'))).rejects.toMatchObject({
      status: 409,
      code: 'policy_changed',
    })
    const policyId = await currentPolicy('cc')
    await h.orch.wfRemap(id, await decision(id, 'cc', { policyId }))
    // The old attempt is closed with its step; the re-created step holds the only reservation.
    expect(
      rows('SELECT state, suspended FROM orc_attempts WHERE id = ?', held!['id'] as string)[0],
    ).toMatchObject({
      state: 'refused',
    })
    expect(rows("SELECT status, disposition, retired FROM orc_steps WHERE id = 's1'")[0]).toEqual({
      status: 'not_started',
      disposition: 'remapped',
      retired: 1,
    })
    await h.until(() => wfRunOf(h, id).assignmentGates.some((g) => g.status === 'open'))
    expect(wfRunOf(h, id).budget.reservedUsd).toBe(0.5)
    expect(node(id, 'a')).toMatchObject({ remaps: 1, attemptsUsed: 1 })
    const fresh = wfRunOf(h, id).assignmentGates.find((g) => g.status === 'open')!
    expect(fresh.payload.policyId).toBe(policyId)
    await h.orch.wfGateDecision(id, fresh.id, {
      decision: 'approve',
      expectedRevision: fresh.revision,
      orchestrationRevision: revision(id),
    })
    await h.until(() => wfRunOf(h, id).status === 'succeeded', 60_000)
    expect(
      rows("SELECT state FROM orc_attempts WHERE kind = 'step' ORDER BY n").map((a) => a['state']),
    ).toEqual(['refused', 'terminated'])
    expect(h.cliCalls()).toHaveLength(1)
    expect(h.errors).toEqual([])
  })

  test('a reach beyond the workspace has to be acknowledged for the new version', async () => {
    await boot()
    replacedAtArming('cx')
    const id = await startWorkflow(h, flow('cx'))
    await h.until(
      () => rows("SELECT 1 FROM orc_steps WHERE disposition = 'agent_changed'").length > 0,
      60_000,
    )
    const policyId = await currentPolicy('cx')
    await expect(h.orch.wfRemap(id, await decision(id, 'cx', { policyId }))).rejects.toMatchObject({
      status: 409,
      code: 'reach_not_acknowledged',
    })
    await h.orch.wfRemap(
      id,
      await decision(id, 'cx', { policyId, acknowledgeCodingReach: { policyIds: [policyId] } }),
    )
    await h.until(() => wfRunOf(h, id).status === 'succeeded', 60_000)
  })

  test('replaced before the step was sent: the remap asks for the same consent and re-creates the step', async () => {
    await boot()
    const id = await startWorkflow(h, flow('cc'), { gatePolicy: 'every-step' })
    await h.until(() => wfRunOf(h, id).assignmentGates.some((g) => g.status === 'open'))
    lifecycle('cc', B)
    await h.until(() => remapCard(id, 'cc') !== undefined)
    await expect(h.orch.wfRemap(id, await decision(id, 'cc'))).rejects.toMatchObject({
      status: 409,
      code: 'policy_changed',
    })
    await h.orch.wfRemap(id, await decision(id, 'cc', { policyId: await currentPolicy('cc') }))
    await h.until(() =>
      wfRunOf(h, id).assignmentGates.some((g) => g.status === 'open' && g.stepId !== 's1'),
    )
    const open = wfRunOf(h, id).assignmentGates.find((g) => g.status === 'open')!
    await h.orch.wfGateDecision(id, open.id, {
      decision: 'approve',
      expectedRevision: open.revision,
      orchestrationRevision: revision(id),
    })
    await h.until(() => wfRunOf(h, id).status === 'succeeded', 60_000)
  })
})
