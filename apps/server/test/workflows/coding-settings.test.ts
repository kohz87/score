import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { buildApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { addCodingAgent, startWorkflow, wfRunOf } from '../helpers/wf-coding.ts'
import { workerHarness, type WorkerHarness } from '../helpers/worker-harness.ts'
import { agent, definition, edge, end } from './wf-harness.ts'

// 7.7c-1 #6 (design §4 W2, W3): assignment gates carry the policy id; a coding node whose agent's settings changed keeps its
// step and offers "Use the new settings" (a node policy-remap), which admits the same attempt again.

vi.setConfig({ testTimeout: 120_000, hookTimeout: 30_000 })
let h: WorkerHarness
let app: FastifyInstance | undefined
afterEach(async () => {
  await app?.close()
  app = undefined
  await h?.close()
  h = undefined as never
})

const rows = (sql: string, ...args: (string | number)[]) =>
  h.rows<Record<string, unknown>>(sql, ...args)
const node = (id: string, nodeId: string) =>
  wfRunOf(h, id).nodeStates.find((n) => n.nodeId === nodeId)!
const revision = (id: string) => h.orch.workflowSummary(id).revision
const flow = (agentId = 'cc') =>
  definition(
    [agent('a', { agentId, instruction: '[fixture:basic] write hello' }), end()],
    [edge('a', 'done')],
  )
const storedPolicy = (agentId: string) =>
  rows('SELECT policy_id FROM orc_worker_policies WHERE agent_id = ?', agentId)[0]!['policy_id']
const currentPolicy = async (workflowAgent: string) =>
  (await h.orch.preflight('lead', [workflowAgent])).workers[0]!.policyId!
async function boot(): Promise<void> {
  h = await workerHarness()
  addCodingAgent(h, 'cc', 'claude-code')
  addCodingAgent(h, 'cx', 'codex', 'read-only')
}
/** A new instruction file appears in the agent's workspace while its step is being armed (before the release decision). */
function changeSettingsAtArming(file: string): void {
  h.fake.hooks.afterStart = () => {
    h.fake.hooks.afterStart = undefined
    writeFileSync(file, 'new instructions')
  }
}
const openGate = (id: string) => wfRunOf(h, id).assignmentGates.findLast((g) => g.status === 'open')
const approve = async (id: string) => {
  const gate = openGate(id)!
  await h.orch.wfGateDecision(id, gate.id, {
    decision: 'approve',
    expectedRevision: gate.revision,
    orchestrationRevision: revision(id),
  })
}

describe('assignment gates of coding steps', () => {
  test('an every-step gate names the agent’s policy id, and approving it runs the step', async () => {
    await boot()
    const id = await startWorkflow(h, flow(), { gatePolicy: 'every-step' })
    await h.until(() => openGate(id) !== undefined)
    expect(openGate(id)!.payload.policyId).toBe(storedPolicy('cc'))
    await approve(id)
    await h.until(() => wfRunOf(h, id).status === 'succeeded', 60_000)
    expect(h.cliCalls()).toHaveLength(1)
    // Never blocked as "agent changed" by a gate that didn't name the policy.
    expect(rows("SELECT 1 FROM orc_steps WHERE disposition = 'agent_changed'")).toEqual([])
  })
})

describe('Use the new settings for a node', () => {
  const blockedByChange = async (
    over: Parameters<typeof startWorkflow>[2] = {},
    agentId = 'cc',
    file = join(h.dir, 'ws-cc', 'CLAUDE.md'),
  ) => {
    changeSettingsAtArming(file)
    const id = await startWorkflow(h, flow(agentId), over)
    await h.until(
      () => rows("SELECT 1 FROM orc_steps WHERE disposition = 'agent_changed'").length > 0,
      60_000,
    )
    return id
  }

  test('the node keeps its step and says why; the decision admits the same attempt under the new settings (gates-only)', async () => {
    await boot()
    const id = await blockedByChange()
    const held = node(id, 'a')
    expect(held).toMatchObject({ state: 'running', waitingFor: 'coding_settings', attemptsUsed: 1 })
    const oldPolicy = storedPolicy('cc')
    const fresh = await currentPolicy('cc')
    expect(fresh).not.toBe(oldPolicy)
    expect(h.orch.workflowSummary(id).needsYou).toContainEqual({
      kind: 'coding_agent_changed',
      nodeId: 'a',
      agentId: 'cc',
      newPolicyId: fresh,
      reach: expect.any(String),
    })
    const [attempt] = rows("SELECT id, suspended FROM orc_attempts WHERE kind = 'step'")
    expect(attempt!['suspended']).toBe(1)
    // The decision names the id the person saw and the node revision the page showed.
    await expect(
      h.orch.wfPolicyRemap(id, 'a', {
        policyId: 'c'.repeat(64),
        expectedNodeRevision: held.revision,
        orchestrationRevision: revision(id),
      }),
    ).rejects.toMatchObject({ status: 409, code: 'policy_changed' })
    await expect(
      h.orch.wfPolicyRemap(id, 'a', {
        policyId: fresh,
        expectedNodeRevision: held.revision + 1,
        orchestrationRevision: revision(id),
      }),
    ).rejects.toMatchObject({ status: 409, code: 'conflict' })
    await h.orch.wfPolicyRemap(id, 'a', {
      policyId: fresh,
      expectedNodeRevision: held.revision,
      orchestrationRevision: revision(id),
    })
    await h.until(() => wfRunOf(h, id).status === 'succeeded', 60_000)
    expect(storedPolicy('cc')).toBe(fresh)
    expect(rows("SELECT id FROM orc_attempts WHERE kind = 'step'").map((a) => a['id'])).toEqual([
      attempt!['id'],
    ])
    expect(node(id, 'a')).toMatchObject({ state: 'succeeded', attemptsUsed: 1 })
    expect(h.cliCalls()).toHaveLength(1)
    expect(h.errors).toEqual([])
  })

  test('under every-step approval the old approval is withdrawn: a fresh gate names the new id and must be approved', async () => {
    await boot()
    changeSettingsAtArming(join(h.dir, 'ws-cc', 'CLAUDE.md'))
    const id = await startWorkflow(h, flow(), { gatePolicy: 'every-step' })
    await h.until(() => openGate(id) !== undefined)
    const oldPolicy = storedPolicy('cc')
    await approve(id)
    await h.until(
      () => rows("SELECT 1 FROM orc_steps WHERE disposition = 'agent_changed'").length > 0,
      60_000,
    )
    const fresh = await currentPolicy('cc')
    await h.orch.wfPolicyRemap(id, 'a', {
      policyId: fresh,
      expectedNodeRevision: node(id, 'a').revision,
      orchestrationRevision: revision(id),
    })
    await h.until(() => openGate(id) !== undefined)
    expect(openGate(id)!.payload.policyId).toBe(fresh)
    expect(openGate(id)!.payload.policyId).not.toBe(oldPolicy)
    // Nothing is sent while the fresh approval is pending.
    await h.orch.admissionChanged()
    await h.orch.idle()
    expect(h.cliCalls()).toHaveLength(0)
    await approve(id)
    await h.until(() => wfRunOf(h, id).status === 'succeeded', 60_000)
    expect(rows("SELECT id FROM orc_attempts WHERE kind = 'step'")).toHaveLength(1)
  })

  test('a reach beyond the workspace has to be acknowledged for the new id', async () => {
    await boot()
    const id = await blockedByChange({}, 'cx', join(h.dir, 'ws-cx', 'AGENTS.md'))
    const fresh = await currentPolicy('cx')
    const body = {
      policyId: fresh,
      expectedNodeRevision: node(id, 'a').revision,
      orchestrationRevision: revision(id),
    }
    await expect(h.orch.wfPolicyRemap(id, 'a', body)).rejects.toMatchObject({
      status: 409,
      code: 'reach_not_acknowledged',
    })
    await h.orch.wfPolicyRemap(id, 'a', { ...body, acknowledgeCodingReach: { policyIds: [fresh] } })
    await h.until(() => wfRunOf(h, id).status === 'succeeded', 60_000)
  })

  test('a node that isn’t waiting for new settings refuses the decision', async () => {
    await boot()
    const id = await startWorkflow(h, flow(), { gatePolicy: 'every-step' })
    await h.until(() => openGate(id) !== undefined)
    await expect(
      h.orch.wfPolicyRemap(id, 'a', {
        policyId: await currentPolicy('cc'),
        expectedNodeRevision: node(id, 'a').revision,
        orchestrationRevision: revision(id),
      }),
    ).rejects.toMatchObject({ status: 409 })
  })

  test('the route: POST …/nodes/:nodeId/policy-remap answers the run summary', async () => {
    await boot()
    app = buildApp({
      config: loadConfig({ SCORE_MODE: 'fake', SCORE_HOME: `${h.dir}/home` }),
      logger: false,
      db: h.db,
      ingest: h.ingest,
      port: h.port,
      orchestrator: h.orch,
    })
    const paired = await app.inject({
      method: 'POST',
      url: '/api/session/pair',
      headers: { 'x-score-client': 'web' },
      payload: { token: app.pairing.createToken() },
    })
    const headers = {
      'x-score-client': 'web',
      cookie: paired.headers['set-cookie']!.toString().split(';')[0]!,
    }
    const id = await blockedByChange()
    const fresh = await currentPolicy('cc')
    const bad = await app.inject({
      method: 'POST',
      url: `/api/workflow-runs/${id}/nodes/a/policy-remap`,
      headers,
      payload: { policyId: fresh, orchestrationRevision: revision(id) },
    })
    expect(bad.statusCode).toBe(400)
    const ok = await app.inject({
      method: 'POST',
      url: `/api/workflow-runs/${id}/nodes/a/policy-remap`,
      headers,
      payload: {
        policyId: fresh,
        expectedNodeRevision: node(id, 'a').revision,
        orchestrationRevision: revision(id),
      },
    })
    expect(ok.statusCode, ok.body).toBe(200)
    expect(ok.json().id).toBe(id)
    await h.until(() => wfRunOf(h, id).status === 'succeeded', 60_000)
  })
})
