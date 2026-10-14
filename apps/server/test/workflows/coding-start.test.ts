import {
  ORCH_LIMITS,
  OrchestrationCreateSchema,
  WorkflowRunCreateSchema,
  ORCH_ACKNOWLEDGEMENT_TEXT,
} from '@score/contract'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { WORKFLOW_CODING_ITEM_BYTES } from '../../src/domain/orchestration/ops.ts'
import { workflowReserve } from '../../src/domain/workflows/runs.ts'
import {
  addCodingAgent,
  consentFor,
  saveWorkflow,
  startWorkflow,
  wfRunOf,
} from '../helpers/wf-coding.ts'
import { workerHarness, type WorkerHarness } from '../helpers/worker-harness.ts'
import { agent, definition, edge, end } from './wf-harness.ts'

// 7.7c-1 #2: workflow preflight reports its coding agents; start carries their policies, the reach acknowledgement
// (workflow cardinality), the coding step limit and the unknown-cost sources; a rerun asks again; the coding storage
// partition is set at creation; a workflow without coding step nodes sends and stores none of it.

vi.setConfig({ testTimeout: 90_000, hookTimeout: 30_000 })
let h: WorkerHarness
afterEach(async () => {
  await h?.close()
  h = undefined as never
})

const codingFlow = () =>
  definition(
    [
      agent('a', { agentId: 'cc', instruction: '[fixture:basic] write hello', retries: 1 }),
      agent('b', { agentId: 'cx', instruction: '[fixture:basic] review' }),
      end(),
    ],
    [edge('a', 'b'), edge('b', 'done')],
  )
const rows = (sql: string, ...args: (string | number)[]) =>
  h.rows<Record<string, unknown>>(sql, ...args)

async function boot(): Promise<void> {
  h = await workerHarness()
  addCodingAgent(h, 'cc', 'claude-code')
  addCodingAgent(h, 'cx', 'codex', 'read-only')
}

describe('workflow preflight', () => {
  test('lists each coding agent with its policy and reach, and the default coding step limit', async () => {
    await boot()
    const id = saveWorkflow(h, codingFlow())
    const pre = await h.orch.workflowPreflight(id, 1)
    expect(pre.workers.map((worker) => [worker.agentId, worker.runtime, worker.readiness])).toEqual(
      [
        ['cc', 'claude-code', 'ready'],
        ['cx', 'codex', 'ready'],
      ],
    )
    expect(pre.workers.every((worker) => /^[0-9a-f]{64}$/.test(worker.policyId ?? ''))).toBe(true)
    expect(pre.workers.find((worker) => worker.agentId === 'cx')?.reachBeyondWorkspace).toBe(true)
    // Two coding nodes, one with a retry: 2 + 1 tries.
    expect(pre.defaults.codingSteps).toBe(3)
    // Seven steps can be created (3 tries and 2 remaps per agent node) and the partition holds three coding items.
    expect(pre.reserveBytes).toBe(workflowReserve(7, 3))
  })

  test('a workflow with Hermes agents only has no workers and no coding default', async () => {
    await boot()
    const id = saveWorkflow(h, definition([agent('a'), end()], [edge('a', 'done')]))
    const pre = await h.orch.workflowPreflight(id, 1)
    expect(pre.workers).toEqual([])
    expect(pre.defaults).not.toHaveProperty('codingSteps')
  })
})

describe('starting a workflow with coding agents', () => {
  test('stores the approved policies, the limit, the accepted sources and the coding partition', async () => {
    await boot()
    const run = await startWorkflow(h, codingFlow(), {
      acceptUnknownCost: ['codex'],
      codingSteps: 4,
      budgetUsd: 20,
    })
    const policies = rows(
      'SELECT agent_id, policy_id, acknowledged_at FROM orc_worker_policies ORDER BY agent_id',
    )
    expect(policies.map((p) => p['agent_id'])).toEqual(['cc', 'cx'])
    // Only the reach beyond the workspace is acknowledged (and recorded as such).
    expect(policies.map((p) => p['acknowledged_at'] !== null)).toEqual([false, true])
    const orch = rows('SELECT * FROM orchestrations WHERE id = ?', run)[0]!
    expect(orch['coding_steps']).toBe(4)
    expect(orch['accepted_unknown_cost']).toBe('["codex"]')
    const steps = Number(orch['max_steps'])
    expect(orch['coding_reserve_bytes']).toBe(4 * WORKFLOW_CODING_ITEM_BYTES)
    expect(orch['reserve_bytes']).toBe(workflowReserve(steps, 4))
    expect(
      rows(
        "SELECT detail FROM orc_history WHERE orchestration_id = ? AND kind = 'coding_reach_acknowledged'",
        run,
      ),
    ).toHaveLength(1)
  })

  test('refuses a start that doesn’t name the settings, names old ones, or leaves a wider reach unacknowledged', async () => {
    await boot()
    const id = saveWorkflow(h, codingFlow())
    const pre = await h.orch.workflowPreflight(id, 1)
    const consent = consentFor(pre)
    const attempt = (over: object) =>
      startWorkflow(h, codingFlow(), { ...over }, { workflowId: id, consent: false })
    await expect(attempt({})).rejects.toMatchObject({ status: 400, code: 'bad_request' })
    await expect(
      attempt({ codingPolicies: { cc: consent.codingPolicies!['cc']! } }),
    ).rejects.toMatchObject({ status: 400 })
    await expect(
      attempt({
        ...consent,
        codingPolicies: { ...consent.codingPolicies, cx: 'f'.repeat(64) },
      }),
    ).rejects.toMatchObject({ status: 409, code: 'policy_changed' })
    await expect(
      attempt({ ...consent, acknowledgeCodingReach: { policyIds: [] } }),
    ).rejects.toMatchObject({ status: 409, code: 'reach_not_acknowledged' })
    // Nothing was created by the refusals.
    expect(rows('SELECT id FROM orchestrations')).toEqual([])
  })

  test('a rerun asks again: nothing carries over from the earlier run', async () => {
    await boot()
    const id = saveWorkflow(h, codingFlow())
    const first = await startWorkflow(h, codingFlow(), {}, { workflowId: id })
    await expect(
      startWorkflow(h, codingFlow(), { rerunOf: first }, { workflowId: id, consent: false }),
    ).rejects.toMatchObject({ status: 400 })
    const second = await startWorkflow(h, codingFlow(), { rerunOf: first }, { workflowId: id })
    expect(wfRunOf(h, second).rerunOf).toBe(first)
    expect(rows('SELECT DISTINCT orchestration_id FROM orc_worker_policies')).toHaveLength(2)
  })

  test('unknown cost: continue accepts every source, pause accepts only the named ones', async () => {
    await boot()
    const id = saveWorkflow(h, codingFlow())
    const kept = await startWorkflow(
      h,
      codingFlow(),
      { unknownSpend: 'continue' },
      { workflowId: id },
    )
    const named = await startWorkflow(
      h,
      codingFlow(),
      { acceptUnknownCost: ['claude-code'] },
      { workflowId: id },
    )
    const row = (run: string) =>
      rows(
        'SELECT accepted_unknown_spend AS s, accepted_unknown_cost AS c FROM orchestrations WHERE id = ?',
        run,
      )[0]!
    expect(row(kept)).toMatchObject({ s: 1, c: '[]' })
    expect(row(named)).toMatchObject({ s: 0, c: '["claude-code"]' })
  })

  test('a workflow with Hermes agents only sends and stores no coding fields', async () => {
    await boot()
    const hermes = definition([agent('a'), end()], [edge('a', 'done')])
    const id = saveWorkflow(h, hermes)
    for (const fields of [
      { codingSteps: 3 },
      { acceptUnknownCost: ['codex' as const] },
      { codingPolicies: { builder: 'a'.repeat(64) } },
      { acknowledgeCodingReach: { policyIds: [] } },
    ])
      await expect(startWorkflow(h, hermes, fields, { workflowId: id })).rejects.toMatchObject({
        status: 400,
        code: 'bad_request',
      })
    const run = await startWorkflow(h, hermes, {}, { workflowId: id })
    const orch = rows('SELECT * FROM orchestrations WHERE id = ?', run)[0]!
    expect(rows('SELECT 1 FROM orc_worker_policies')).toEqual([])
    expect(orch['coding_reserve_bytes']).toBe(0)
    expect(orch['accepted_unknown_cost']).toBe('[]')
    expect(orch['reserve_bytes']).toBe(workflowReserve(Number(orch['max_steps'])))
    expect(rows("SELECT 1 FROM orc_history WHERE kind = 'coding_reach_acknowledged'")).toEqual([])
  })
})

describe('consent cardinality', () => {
  test('a workflow with nine coding agents can be acknowledged; an orchestration still caps at eight', async () => {
    const ids = Array.from({ length: 9 }, (_, i) => `c${i + 1}`)
    h = await workerHarness()
    // Codex read-only: every one of them needs the reach acknowledged.
    for (const id of ids) addCodingAgent(h, id, 'codex', 'read-only')
    const nodes = ids.map((agentId) =>
      agent(`n-${agentId}`, { agentId, instruction: '[fixture:basic] go' }),
    )
    const def = definition(
      [...nodes, end()],
      [
        ...ids.slice(0, -1).map((a, i) => edge(`n-${a}`, `n-${ids[i + 1]!}`)),
        edge(`n-${ids.at(-1)!}`, 'done'),
      ],
    )
    const id = saveWorkflow(h, def)
    const pre = await h.orch.workflowPreflight(id, 1)
    expect(new Set(pre.workers.map((worker) => worker.policyId)).size).toBe(9)
    const run = await startWorkflow(h, def, {}, { workflowId: id })
    expect(
      rows('SELECT agent_id FROM orc_worker_policies WHERE orchestration_id = ?', run),
    ).toHaveLength(9)
    // The schemas: nine policy ids pass for a workflow, and the orchestration's own bound is unchanged.
    const nine = {
      policyIds: Array.from({ length: 9 }, (_, i) => String(i).repeat(64).slice(0, 64)),
    }
    expect(
      WorkflowRunCreateSchema.safeParse({
        workflowId: 'wf-1',
        version: 1,
        inputs: {},
        agentMap: [],
        acknowledgement: { text: ORCH_ACKNOWLEDGEMENT_TEXT },
        acknowledgeCodingReach: nine,
      }).success,
    ).toBe(true)
    expect(ORCH_LIMITS.maxAllowedAgents).toBe(8)
    expect(
      OrchestrationCreateSchema.safeParse({
        goal: 'x',
        leadAgentId: 'lead',
        allowedAgents: ['a'],
        acknowledgement: { text: ORCH_ACKNOWLEDGEMENT_TEXT },
        acknowledgeCodingReach: nine,
      }).success,
    ).toBe(false)
  })
})
