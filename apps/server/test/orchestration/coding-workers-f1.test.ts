import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, vi, describe, expect, test } from 'vitest'
import { claudeDriver } from '../../src/runtimes/coding/claude.ts'
import { codexDriver } from '../../src/runtimes/coding/codex.ts'
import { PolicyUnverifiable, mainCheckoutOf } from '../../src/runtimes/coding/worker-sources.ts'
import type { LeadScript } from '../../src/hermes/fake/fake-lead.ts'
import { budgetView } from '../../src/domain/orchestration/budget.ts'
import { readOrch } from '../../src/domain/orchestration/store.ts'
import { byTurn } from '../../src/hermes/fake/fake-lead.ts'
import { workerHarness, type WorkerHarness } from '../helpers/worker-harness.ts'

// 7.7b-F1: regression tests for the code review of 2026-10-14 (docs/reviews/2026-10-14-7.7b-code-review.md). Each test
// is that review's probe, written to fail on the code the review found.

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 })

let h: WorkerHarness
afterEach(async () => {
  await h?.close()
  h = undefined as never
})

const oneStep = (instruction = '[fixture:basic] write hello') =>
  byTurn({
    1: async (t) => {
      await t.call('orch.assign', { agent: 'coder', instruction })
      return 'assigned'
    },
    2: async (t) => {
      await t.call('orch.finish', { outcome: 'success', summary: 'done' })
    },
  })
const attempt = () =>
  h.rows<Record<string, unknown>>("SELECT * FROM orc_attempts WHERE kind = 'step' ORDER BY n")[0]!
const gens = () =>
  h.rows<Record<string, unknown>>('SELECT * FROM orc_generations ORDER BY generation')
const sql = (text: string, ...args: (string | number | null)[]) =>
  h.db.sqlite.prepare(text).run(...args)

function atArming(change: () => void): void {
  h.fake.hooks.afterStart = () => {
    h.fake.hooks.afterStart = undefined
    change()
  }
}
const closed = () => h.until(() => gens().some((g) => g['closed_cause'] !== null))

describe('#1 release reads fresh spend', () => {
  /** A sibling attempt whose run committed terminal state (and cost) that the executor has not reconciled yet. */
  function sibling(cost: number | null): void {
    const base = attempt()
    const row = {
      ...base,
      id: 'sibling-attempt',
      n: 99,
      turn_id: 'sibling-turn',
      state: 'running',
      run_id: 'sibling-run',
      reserved_usd: 0,
      spend_usd: null,
      settled: 0,
      suspended: 0,
    }
    const names = Object.keys(row)
    h.db.sqlite
      .prepare(
        `INSERT INTO orc_attempts (${names.join(',')}) VALUES (${names.map(() => '?').join(',')})`,
      )
      .run(...(Object.values(row) as (string | number | null)[]))
    h.db.sqlite
      .prepare(
        `INSERT INTO runs (id, profile, origin, session_id, status, started_at, cost_usd, updated_at)
         VALUES ('sibling-run', 'coder', 'score', 'sibling-session', 'completed', ?, ?, ?)`,
      )
      .run(new Date().toISOString(), cost, new Date().toISOString())
  }

  test.each([
    ['committed spend over the budget', 10, 'budget'],
    ['unaccepted unknown cost', null, 'unknown_cost'],
  ] as const)('%s denies the release', async (_name, cost, cause) => {
    h = await workerHarness({ lead: { script: oneStep() } })
    h.addAgent()
    atArming(() => sibling(cost))
    await h.create({ budgetUsd: 5 })
    await closed()
    expect(gens()[0]).toMatchObject({ generation: 1, closed_cause: cause })
    expect(h.cliCalls()).toHaveLength(0)
  })
})

describe('#2 configuration outside the workspace ancestors (a Git worktree)', () => {
  /** `<h.workspace>` becomes a linked worktree of a main checkout somewhere else. Returns the main checkout. */
  function makeWorktree(): string {
    const main = join(h.dir, 'main-checkout')
    const gitDir = join(main, '.git', 'worktrees', 'wt')
    mkdirSync(gitDir, { recursive: true })
    writeFileSync(join(gitDir, 'commondir'), '../..\n')
    writeFileSync(join(h.workspace, '.git'), `gitdir: ${gitDir}\n`)
    return main
  }

  test('the main checkout of a linked worktree is found from Git metadata alone', async () => {
    h = await workerHarness({ lead: { script: oneStep() } })
    const main = makeWorktree()
    expect(mainCheckoutOf(h.workspace)).toBe(main)
    const context = { home: h.home, workspace: h.workspace, env: {} }
    for (const driver of [claudeDriver, codexDriver]) {
      const bound = driver.worker!.bound(context)
      expect(bound.some((path) => path.startsWith(main + '/'))).toBe(true)
    }
    expect(claudeDriver.worker!.bound(context)).toContain(
      join(main, '.claude', 'settings.local.json'),
    )
    expect(codexDriver.worker!.bound(context)).toContain(join(main, '.codex', 'config.toml'))
  })

  test('changing the main checkout’s settings.local.json changes the policy id (stat only: unreadable contents are fine)', async () => {
    h = await workerHarness({ lead: { script: oneStep() } })
    h.addAgent()
    const main = makeWorktree()
    const idOf = async () => (await h.orch.preflight('lead', ['coder'])).workers[0]!.policyId
    const before = await idOf()
    mkdirSync(join(main, '.claude'), { recursive: true })
    const file = join(main, '.claude', 'settings.local.json')
    writeFileSync(file, '{"permissions":{"allow":["Bash"]}}')
    // Nothing may open the file: it has no permission bits at all.
    chmodSync(file, 0)
    const after = await idOf()
    expect(after).toBeTruthy()
    expect(after).not.toBe(before)
  })

  test('a worktree whose main checkout can’t be located is unverifiable, never silently ignored', async () => {
    h = await workerHarness({ lead: { script: oneStep() } })
    h.addAgent()
    writeFileSync(join(h.workspace, '.git'), 'not a pointer\n')
    expect(() => mainCheckoutOf(h.workspace)).toThrow(PolicyUnverifiable)
    const entry = (await h.orch.preflight('lead', ['coder'])).workers[0]!
    expect(entry.readiness).toBe('reach_unverifiable')
  })

  test('an ordinary checkout has no extra location', async () => {
    h = await workerHarness({ lead: { script: oneStep() } })
    mkdirSync(join(h.workspace, '.git'))
    expect(mainCheckoutOf(h.workspace)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------------------------------- #4, #5

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
const revision = (id: string) => h.orch.summary(id).revision
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
