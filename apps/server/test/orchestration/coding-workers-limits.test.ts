import { afterEach, describe, expect, test, vi } from 'vitest'
import type { LeadScript } from '../../src/hermes/fake/fake-lead.ts'
import { workerHarness, type WorkerHarness } from '../helpers/worker-harness.ts'

// 7.7b-2 §8: the coding step limit is derived from the coding journal; unknown cost is tracked and accepted per source.
// A suspended attempt is admitted again as the SAME attempt once the limit is raised.

vi.setConfig({ testTimeout: 90_000, hookTimeout: 30_000 })

let h: WorkerHarness
afterEach(async () => {
  await h?.close()
  h = undefined as never
})

/** Assigns the given steps once, waits for them, and finishes when all have succeeded. */
const plan =
  (steps: { agent: string; after?: number }[]): LeadScript =>
  async (t) => {
    if (t.steps.length === 0) {
      const ids: string[] = []
      for (const step of steps) {
        const receipt = await t.call('orch.assign', {
          agent: step.agent,
          instruction: '[fixture:basic] write hello',
          ...(step.after === undefined ? {} : { after: [ids[step.after]!] }),
        })
        ids.push(String((receipt as { result?: { stepId?: string } }).result?.stepId))
      }
      return 'assigned'
    }
    if (t.steps.every((s) => s.status === 'succeeded')) {
      await t.call('orch.finish', { outcome: 'success', summary: 'done' })
      return 'done'
    }
    return 'waiting'
  }
const stepsRows = () =>
  h.rows<{ id: string; status: string; disposition: string | null; agent_id: string }>(
    'SELECT id, status, disposition, agent_id FROM orc_steps ORDER BY seq',
  )
const stepAttempts = () =>
  h.rows<Record<string, unknown>>("SELECT * FROM orc_attempts WHERE kind = 'step' ORDER BY n, id")
const revision = (id: string) => h.orch.summary(id).revision

describe('the coding step limit', () => {
  test('the step past the limit is blocked and suspended; raising the limit admits the same attempt', async () => {
    h = await workerHarness({ lead: { script: plan([{ agent: 'coder' }, { agent: 'coder' }]) } })
    h.addAgent()
    const id = await h.create({ codingSteps: 1, maxConcurrentSteps: 1 })
    await h.until(() => stepsRows()[1]?.disposition === 'coding_limit', 60_000)
    expect(stepsRows()).toMatchObject([
      { status: 'succeeded' },
      { status: 'blocked', disposition: 'coding_limit' },
    ])
    expect(h.cliCalls()).toHaveLength(1)
    expect(h.orch.summary(id).needsYou).toContainEqual({ kind: 'coding_limit', stepId: 's2' })
    const [first, second] = stepAttempts()
    expect(second).toMatchObject({ suspended: 1, state: 'created' })
    // The person raises the limit: the blocked step goes on with its one attempt.
    await h.orch.limits(id, { codingSteps: 2, orchestrationRevision: revision(id) })
    await h.until(() => h.orch.summary(id).status === 'succeeded', 60_000)
    expect(stepAttempts().map((a) => a['id'])).toEqual([first!['id'], second!['id']])
    expect(h.cliCalls()).toHaveLength(2)
    expect(h.errors).toEqual([])
  })

  test('the count comes from the coding journal: it survives a lost projection and compaction', async () => {
    h = await workerHarness({ lead: { script: plan([{ agent: 'coder' }]) } })
    h.addAgent()
    const id = await h.create({ codingSteps: 3 })
    await h.until(() => h.orch.summary(id).status === 'succeeded', 60_000)
    const count = () => h.journal.critical((tx) => tx.executedBy(id))
    expect(count()).toBe(1)
    // A restored database may lack the projection rows altogether; compaction folds records into tombstones.
    h.db.sqlite.exec('DELETE FROM coding_launches')
    h.journal.compact(() => true)
    expect(count()).toBe(1)
    // A launch of another orchestration is not counted.
    expect(h.journal.critical((tx) => tx.executedBy('orc-other'))).toBe(0)
  })

  test('the limit and the accepted sources are journaled with the run and verified after a restore', async () => {
    h = await workerHarness({ lead: { script: plan([{ agent: 'coder' }]) } })
    h.addAgent()
    const id = await h.create({ codingSteps: 4, acceptUnknownCost: ['codex'] })
    await h.until(() => h.orch.summary(id).status === 'succeeded', 60_000)
    await h.orch.maintenance()
    // A database restored from before a tightening is more permissive than the journal: that is detected at start.
    h.db.sqlite.exec(
      'UPDATE orchestrations SET coding_steps = 9, accepted_unknown_cost = \'["claude-code","codex"]\'',
    )
    await h.restart()
    const view = h.fence.view()
    expect(view.fenced).toBe(true)
    expect(JSON.stringify(view.items)).toContain('a lowered coding step limit')
    expect(JSON.stringify(view.items)).toContain('an unknown-cost acceptance that was taken back')
  })
})

describe('unknown cost per source', () => {
  async function codexThenClaude() {
    h = await workerHarness({
      lead: { script: plan([{ agent: 'cx' }, { agent: 'coder', after: 0 }]) },
    })
    h.addAgent('coder')
    h.addAgent('cx', 'codex', 'read-only')
    return h.create({
      allowedAgents: ['coder', 'cx'],
      budgetUsd: 50,
      maxConcurrentSteps: 1,
    })
  }

  test('a Codex step ends without a cost: the run pauses until that source is accepted', async () => {
    const id = await codexThenClaude()
    await h.until(() => h.orch.summary(id).status === 'paused', 60_000)
    expect(h.orch.summary(id)).toMatchObject({ pauseReason: 'unknown_spend' })
    expect(stepsRows()[0]).toMatchObject({ status: 'succeeded' })
    // Another source's acceptance doesn't help.
    await h.orch.limits(id, {
      acceptUnknownCost: { add: ['claude-code', 'hermes'] },
      orchestrationRevision: revision(id),
    })
    await h.orch.admissionChanged()
    await h.orch.idle()
    expect(h.orch.summary(id).status).toBe('paused')
    expect(h.orch.snapshot(id).orchestration.coding?.acceptedUnknownCost).toEqual([
      'claude-code',
      'hermes',
    ])
    // Accepting the source that has the unknown cost lets the run go on.
    await h.orch.limits(id, {
      acceptUnknownCost: { add: ['codex'], remove: ['hermes'] },
      orchestrationRevision: revision(id),
    })
    await h.until(() => h.orch.summary(id).status === 'succeeded', 60_000)
    expect(h.orch.snapshot(id).orchestration.coding?.acceptedUnknownCost).toEqual([
      'claude-code',
      'codex',
    ])
  })

  test('without a dollar budget nothing pauses', async () => {
    h = await workerHarness({
      lead: { script: plan([{ agent: 'cx' }, { agent: 'coder', after: 0 }]) },
    })
    h.addAgent('coder')
    h.addAgent('cx', 'codex', 'read-only')
    const id = await h.create({ allowedAgents: ['coder', 'cx'], maxConcurrentSteps: 1 })
    await h.until(() => h.orch.summary(id).status === 'succeeded', 60_000)
  })

  test('accepting a source at the start lets the run through', async () => {
    h = await workerHarness({
      lead: { script: plan([{ agent: 'cx' }, { agent: 'coder', after: 0 }]) },
    })
    h.addAgent('coder')
    h.addAgent('cx', 'codex', 'read-only')
    const id = await h.create({
      allowedAgents: ['coder', 'cx'],
      budgetUsd: 50,
      maxConcurrentSteps: 1,
      acceptUnknownCost: ['codex'],
    })
    await h.until(() => h.orch.summary(id).status === 'succeeded', 60_000)
  })
})
