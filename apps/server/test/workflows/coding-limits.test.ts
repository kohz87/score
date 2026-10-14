import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  codingUnsentBytes,
  WORKFLOW_CODING_ITEM_BYTES,
} from '../../src/domain/orchestration/ops.ts'
import { addCodingAgent, startWorkflow, wfRunOf } from '../helpers/wf-coding.ts'
import { workerHarness, type WorkerHarness } from '../helpers/worker-harness.ts'
import { agent, definition, edge, end } from './wf-harness.ts'

// 7.7c-1 #3: a workflow's coding authorisation is reported as it stands now (the `coding` block, effective unknown spend),
// and the workflow limits decision changes it: the coding step limit grows the partition by the PLANNER's item size,
// accepted sources are scoped, both journaled and verified after a restore.

vi.setConfig({ testTimeout: 90_000, hookTimeout: 30_000 })
let h: WorkerHarness
afterEach(async () => {
  await h?.close()
  h = undefined as never
})

const flow = () =>
  definition(
    [
      agent('a', { agentId: 'cc', instruction: '[fixture:basic] write hello' }),
      agent('b', { agentId: 'cx', instruction: '[fixture:basic] review' }),
      end(),
    ],
    [edge('a', 'b'), edge('b', 'done')],
  )
// Holds the run before its first step: the pause is the person's.
const paused = { gatePolicy: 'every-step' as const }
const rows = (sql: string, ...args: (string | number)[]) =>
  h.rows<Record<string, unknown>>(sql, ...args)
const revision = (id: string) => h.orch.workflowSummary(id).revision
async function boot(): Promise<void> {
  h = await workerHarness()
  addCodingAgent(h, 'cc', 'claude-code')
  addCodingAgent(h, 'cx', 'codex', 'read-only')
}

describe('the coding block of a workflow run', () => {
  test('is the current authorisation: workers, limit, use, accepted sources and effective unknown spend', async () => {
    await boot()
    const id = await startWorkflow(h, flow(), {
      ...paused,
      unknownSpend: 'continue',
      codingSteps: 5,
    })
    const summary = h.orch.workflowSummary(id)
    expect(summary.coding).toMatchObject({
      codingSteps: 5,
      used: 0,
      acceptedUnknownCost: [],
      unknownSpend: 'continue',
    })
    expect(summary.coding?.workers.map((w) => [w.agentId, w.runtime])).toEqual([
      ['cc', 'claude-code'],
      ['cx', 'codex'],
    ])
    expect(wfRunOf(h, id).coding).toEqual(summary.coding)
    // Taking the acceptance back shows in both the block and the detail's own field: not the start-time snapshot.
    await h.orch.wfLimits(id, { acceptUnknownSpend: false, orchestrationRevision: revision(id) })
    expect(h.orch.workflowSummary(id).coding?.unknownSpend).toBe('pause')
    expect(wfRunOf(h, id).unknownSpend).toBe('pause')
    await h.orch.wfLimits(id, { acceptUnknownSpend: true, orchestrationRevision: revision(id) })
    expect(wfRunOf(h, id).unknownSpend).toBe('continue')
  })

  test('a workflow without coding agents has no block and refuses coding settings', async () => {
    await boot()
    const hermes = definition([agent('a'), end()], [edge('a', 'done')])
    const id = await startWorkflow(h, hermes, paused)
    expect(h.orch.workflowSummary(id).coding).toBeUndefined()
    expect(wfRunOf(h, id)).not.toHaveProperty('coding')
    await expect(
      h.orch.wfLimits(id, { codingSteps: 3, orchestrationRevision: revision(id) }),
    ).rejects.toMatchObject({ status: 400 })
    await expect(
      h.orch.wfLimits(id, {
        acceptUnknownCost: { add: ['codex'] },
        orchestrationRevision: revision(id),
      }),
    ).rejects.toMatchObject({ status: 400 })
    await h.orch.wfLimits(id, { budgetUsd: 5, orchestrationRevision: revision(id) })
  })
})

describe('the workflow limits decision', () => {
  test('a higher coding step limit grows the partition by the workflow item, never by the orchestration one', async () => {
    await boot()
    const id = await startWorkflow(h, flow(), { ...paused, codingSteps: 2 })
    const row = () =>
      rows(
        'SELECT reserve_bytes AS r, coding_reserve_bytes AS c, max_steps AS m FROM orchestrations WHERE id = ?',
        id,
      )[0]!
    const before = row()
    const unsent = codingUnsentBytes(Number(before['m']), 2)
    expect(before['c']).toBe(2 * WORKFLOW_CODING_ITEM_BYTES + unsent)
    await h.orch.wfLimits(id, { codingSteps: 5, orchestrationRevision: revision(id) })
    const grown = row()
    expect(Number(grown['m'])).toBeGreaterThanOrEqual(5)
    expect(grown['c']).toBe(5 * WORKFLOW_CODING_ITEM_BYTES + unsent)
    expect(Number(grown['r']) - Number(before['r'])).toBe(3 * WORKFLOW_CODING_ITEM_BYTES)
    // Lowering keeps the reserve, and raising again within it adds nothing.
    await h.orch.wfLimits(id, { codingSteps: 1, orchestrationRevision: revision(id) })
    await h.orch.wfLimits(id, { codingSteps: 5, orchestrationRevision: revision(id) })
    expect(row()).toEqual(grown)
  })

  test('accepted sources are scoped and journaled; a database that lost a take-back is found at start', async () => {
    await boot()
    const id = await startWorkflow(h, flow(), {
      ...paused,
      acceptUnknownCost: ['claude-code', 'codex'],
    })
    await h.orch.wfLimits(id, {
      acceptUnknownCost: { remove: ['claude-code'] },
      orchestrationRevision: revision(id),
    })
    expect(h.orch.workflowSummary(id).coding?.acceptedUnknownCost).toEqual(['codex'])
    await h.orch.maintenance()
    h.db.sqlite.exec(
      'UPDATE orchestrations SET accepted_unknown_cost = \'["claude-code","codex"]\'',
    )
    await h.restart()
    const view = h.fence.view()
    expect(view.fenced).toBe(true)
    expect(JSON.stringify(view.items)).toContain('an unknown-cost acceptance that was taken back')
  })
})
