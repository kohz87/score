import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import type { LeadScript } from '../../src/hermes/fake/fake-lead.ts'
import { budgetView } from '../../src/domain/orchestration/budget.ts'
import { readOrch } from '../../src/domain/orchestration/store.ts'
import { workerHarness, type WorkerHarness } from '../helpers/worker-harness.ts'
import { attempt, atArming, revision, useWorkerHarness } from './coding-workers-helpers.ts'

// 7.7b-F1: regression tests for the code review of 2026-10-14 (docs/reviews/2026-10-14-7.7b-code-review.md). Each test
// is that review's probe, written to fail on the code the review found.

let h: WorkerHarness
useWorkerHarness(
  () => h,
  () => {
    h = undefined as never
  },
)

const plan =
  (count: number): LeadScript =>
  async (t) => {
    if (t.steps.length === 0) {
      for (let i = 0; i < count; i++)
        await t.call('orch.assign', { agent: 'coder', instruction: '[fixture:basic] write hello' })
      return 'assigned'
    }
    if (t.steps.every((s) => s.status === 'succeeded')) {
      await t.call('orch.finish', { outcome: 'success', summary: 'done' })
      return 'done'
    }
    return 'waiting'
  }
const stepStatus = (id: string) =>
  h.rows<{ status: string; disposition: string | null }>(
    'SELECT status, disposition FROM orc_steps WHERE id = ?',
    id,
  )[0]!
const currentPolicy = async () => (await h.orch.preflight('lead', ['coder'])).workers[0]!.policyId!
/** The decision names the revision the page saw; the executor may bump it between two decisions, so it is re-read. */
async function remap(id: string, stepId: string, policyId: string): Promise<void> {
  for (let tries = 0; ; tries++) {
    try {
      await h.orch.policyRemap(id, stepId, {
        agentId: 'coder',
        policyId,
        orchestrationRevision: revision(id),
      })
      return
    } catch (error) {
      const stale = (error as { details?: { currentRevision?: number } }).details?.currentRevision
      if (stale === undefined || tries > 5) throw error
    }
  }
}
const writeClaudeMd = () => writeFileSync(join(h.workspace, 'CLAUDE.md'), 'new instructions')
const gateOf = (id: string, stepId: string) =>
  h.orch
    .snapshot(id)
    .orchestration.gates.findLast((g) => g.stepId === stepId && g.status !== 'withdrawn')!

describe('#4 a remap is judged against the step’s own approved settings', () => {
  test('two steps of one worker blocked under the same settings can both be remapped', async () => {
    h = await workerHarness({ lead: { script: plan(2) } })
    h.addAgent()
    atArming(writeClaudeMd)
    const id = await h.create({ gatePolicy: 'none', maxConcurrentSteps: 2 })
    await h.until(
      () => stepStatus('s1').status === 'blocked' && stepStatus('s2').status === 'blocked',
    )
    const fresh = await currentPolicy()
    await remap(id, 's1', fresh)
    // The worker's stored mapping is now `fresh`; s2's attempt was still approved with the old settings.
    await remap(id, 's2', fresh)
    await h.until(() => h.orch.summary(id).status === 'succeeded', 60_000)
    expect(h.errors).toEqual([])
  })
})

describe('#4 (F2 #3) each step keeps its own approved mapping through readmission', () => {
  test('S1 remapped to B, S2 remapped to C, S1’s B gate approved: S1 is blocked and can still be remapped to C', async () => {
    h = await workerHarness({ lead: { script: plan(2) } })
    h.addAgent()
    atArming(writeClaudeMd)
    const id = await h.create({ gatePolicy: 'every-step', maxConcurrentSteps: 2 })
    const approve = async (stepId: string) => {
      await h.until(() => gateOf(id, stepId)?.status === 'open')
      for (let tries = 0; ; tries++) {
        const gate = gateOf(id, stepId)
        try {
          await h.orch.gateDecision(id, gate.id, {
            decision: 'approve',
            expectedRevision: gate.revision,
            orchestrationRevision: revision(id),
          })
          return
        } catch (error) {
          const stale = (error as { details?: { currentRevision?: number } }).details
            ?.currentRevision
          if (stale === undefined || tries > 5) throw error
        }
      }
    }
    await approve('s1')
    await approve('s2')
    await h.until(
      () => stepStatus('s1').status === 'blocked' && stepStatus('s2').status === 'blocked',
    )
    const b = await currentPolicy()
    await remap(id, 's1', b)
    writeFileSync(join(h.workspace, 'CLAUDE.md'), 'newer instructions, again')
    const c = await currentPolicy()
    expect(c).not.toBe(b)
    await remap(id, 's2', c)
    // S1's renewed gate names B; approving it must not rewrite S1's attempt to C.
    await approve('s1')
    await h.until(() => stepStatus('s1').status === 'blocked')
    await remap(id, 's1', c)
    await approve('s1')
    await approve('s2')
    await h.until(() => h.orch.summary(id).status === 'succeeded', 60_000)
    expect(h.errors).toEqual([])
  })
})

describe('#5 rejecting the renewed gate closes the suspended attempt', () => {
  test('the step is rejected and its $0.50 reservation is released', async () => {
    h = await workerHarness({ lead: { script: plan(1) } })
    h.addAgent()
    atArming(writeClaudeMd)
    const id = await h.create({ gatePolicy: 'every-step', budgetUsd: 20 })
    await h.until(() => gateOf(id, 's1')?.status === 'open')
    const first = gateOf(id, 's1')
    await h.orch.gateDecision(id, first.id, {
      decision: 'approve',
      expectedRevision: first.revision,
      orchestrationRevision: revision(id),
    })
    await h.until(() => stepStatus('s1').status === 'blocked')
    await h.orch.policyRemap(id, 's1', {
      agentId: 'coder',
      policyId: await currentPolicy(),
      orchestrationRevision: revision(id),
    })
    const renewed = gateOf(id, 's1')
    expect(renewed.status).toBe('open')
    const reserved = () =>
      h.db.read((sqlite) => budgetView(sqlite, readOrch(sqlite, id)!)).reservedUsd
    expect(reserved()).toBeGreaterThanOrEqual(0.5)
    await h.orch.gateDecision(id, renewed.id, {
      decision: 'reject',
      expectedRevision: renewed.revision,
      orchestrationRevision: revision(id),
    })
    expect(stepStatus('s1').status).toBe('rejected')
    expect(attempt()).toMatchObject({ state: 'refused' })
    // Only the lead's own turn estimate may remain reserved, not the rejected step's $0.50.
    const stepReserved = h.rows<{ r: number }>(
      "SELECT COALESCE(SUM(reserved_usd), 0) AS r FROM orc_attempts WHERE kind = 'step' AND state != 'refused'",
    )[0]!.r
    expect(stepReserved).toBe(0)
  })
})
