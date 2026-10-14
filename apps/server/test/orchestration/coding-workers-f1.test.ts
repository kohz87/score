import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, vi, describe, expect, test } from 'vitest'
import { claudeDriver } from '../../src/runtimes/coding/claude.ts'
import { codexDriver } from '../../src/runtimes/coding/codex.ts'
import { PolicyUnverifiable, mainCheckoutOf } from '../../src/runtimes/coding/worker-sources.ts'
import type { LeadScript } from '../../src/hermes/fake/fake-lead.ts'
import { budgetView } from '../../src/domain/orchestration/budget.ts'
import {
  CODING_ITEM_EXTRA_BYTES,
  codingItemsFor,
  reserveFor,
  CODING_OUTPUT_BYTES,
  CODING_RESULT_BYTES,
} from '../../src/domain/orchestration/ops.ts'
import { ORCH_LIMITS } from '@score/contract'
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
      // Keeps the executor's own sweep from reconciling this forged sibling before the release decision looks at it
      // (the sweep skips `history_reset` attempts); the decision itself doesn't care.
      unknown_reason: 'history_reset',
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
    ['', {}],
    [
      ' (with Hermes unknown cost accepted: the per-source path)',
      { acceptUnknownCost: ['hermes'] },
    ],
  ] as const)(
    'a proven-unsent sibling (revoked launch, may_have_executed = 0) counts zero spend, not unknown cost%s',
    async (_name, extra) => {
      h = await workerHarness({ lead: { script: oneStep() } })
      h.addAgent()
      atArming(() => {
        sibling(null)
        // The reviewer's case: a Hermes step that ended without a recorded cost (accepted), beside the never-run sibling.
        if ('acceptUnknownCost' in extra) {
          const hermes = {
            ...attempt(),
            id: 'hermes-attempt',
            n: 98,
            turn_id: 'hermes-turn',
            runtime: 'hermes',
            state: 'terminated',
            run_id: null,
            reserved_usd: 0,
            spend_usd: null,
            settled: 0,
            suspended: 0,
            unknown_reason: 'history_reset',
          }
          const names = Object.keys(hermes)
          h.db.sqlite
            .prepare(
              `INSERT INTO orc_attempts (${names.join(',')}) VALUES (${names.map(() => '?').join(',')})`,
            )
            .run(...(Object.values(hermes) as (string | number | null)[]))
        }
        const now = new Date().toISOString()
        sql(
          `INSERT INTO orc_generations (attempt_id, generation, turn_id, launch_id, message_id, run_id, created_at)
         SELECT 'sibling-attempt', dispatch_generation, 'sibling-turn:g1', 'sibling-launch', 'sibling-msg', 'sibling-run', ?
         FROM orc_attempts WHERE id = 'sibling-attempt'`,
          now,
        )
        sql(
          `INSERT INTO coding_launches (launch_id, run_id, turn_id, generation, phase, revoked, may_have_executed, journal_n, updated_at)
         VALUES ('sibling-launch', 'sibling-run', 'sibling-turn:g1', 1, 'revoked', 1, 0, 1, ?)`,
          now,
        )
      })
      await h.create({ budgetUsd: 5, ...extra })
      // The release is granted: the generation reaches the CLI instead of closing with `unknown_cost`.
      await h.until(() => h.cliCalls().length > 0)
      expect(gens().map((g) => g['closed_cause'])).not.toContain('unknown_cost')
    },
  )

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
    writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/main\n')
    writeFileSync(join(main, '.git', 'HEAD'), 'ref: refs/heads/main\n')
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

describe('#7 coding inventory has its own part of the reserve', () => {
  const orch = () => h.rows<Record<string, number>>('SELECT * FROM orchestrations')[0]!

  test('observations that use up the ordinary allowance can’t spend the coding part: the result is still kept', async () => {
    h = await workerHarness({ lead: { script: oneStep() } })
    h.addAgent()
    const id = await h.create()
    // Only the coding part and the protected control reserve are left: no ordinary room for an observation row.
    sql(
      'UPDATE orchestrations SET stored_bytes = reserve_bytes - coding_reserve_bytes - 262144 - 3000',
    )
    await h.until(() => h.orch.summary(id).status === 'succeeded', 40_000)
    expect(h.rows("SELECT 1 FROM tool_calls WHERE run_id LIKE 'cr_%'")).toHaveLength(0)
    expect(
      h.rows<{ result_text: string }>(
        'SELECT result_text FROM orc_attempts WHERE kind = ?',
        'step',
      )[0]!.result_text,
    ).toBeTruthy()
    // What the coding step kept is charged to the coding part.
    expect(orch()['coding_stored_bytes']).toBeGreaterThan(0)
  })

  test('maximum-sized inventory after the ordinary room is gone never reaches the control reserve (F2 #4)', async () => {
    h = await workerHarness({ lead: { script: byTurn({ 1: async () => 'waiting' }) } })
    h.addAgent()
    const id = await h.create({ codingSteps: 1 })
    // Observations have used all the ordinary room: only the coding part and the control reserve remain.
    sql(
      'UPDATE orchestrations SET coding_stored_bytes = 0, stored_bytes = reserve_bytes - coding_reserve_bytes - ?',
      ORCH_LIMITS.controlReserveBytes,
    )
    // One item's largest inventory: the input, two copies of the longest result, the retained reply and the run output.
    const resultCopy = CODING_RESULT_BYTES + 128
    const largest =
      ORCH_LIMITS.stepInputBytes + 2 * resultCopy + CODING_RESULT_BYTES + CODING_OUTPUT_BYTES
    h.db.sqlite
      .prepare(
        'UPDATE orchestrations SET stored_bytes = stored_bytes + ?, coding_stored_bytes = coding_stored_bytes + ? WHERE id = ?',
      )
      .run(largest, largest, id)
    const row = orch()
    expect(row['reserve_bytes']! - row['stored_bytes']!).toBeGreaterThanOrEqual(
      ORCH_LIMITS.controlReserveBytes,
    )
  })

  test('every retained copy of the result is charged: the step result and attempt result, the run output and coding_run_results', async () => {
    h = await workerHarness({ lead: { script: oneStep() } })
    h.addAgent()
    const id = await h.create()
    await h.until(() => h.orch.summary(id).status === 'succeeded', 40_000)
    const reply = h.rows<{ reply: string }>('SELECT reply FROM coding_run_results')[0]!.reply
    const result = h.rows<{ result: string }>('SELECT result FROM orc_steps')[0]!.result
    const output = h.rows<{ output: string | null }>(
      "SELECT output FROM runs WHERE id LIKE 'cr_%'",
    )[0]!.output
    expect(orch()['coding_stored_bytes']).toBeGreaterThanOrEqual(
      Buffer.byteLength(result) * 2 + Buffer.byteLength(output ?? '') + Buffer.byteLength(reply),
    )
  })

  test('lowering then restoring codingSteps does not reserve twice (F2 #5)', async () => {
    const quota = reserveFor(12, 20, codingItemsFor(12, 10))
    h = await workerHarness({
      lead: { script: byTurn({ 1: async () => 'waiting', 2: async () => 'waiting' }) },
      orchestrator: { quotaBytes: quota },
    })
    h.addAgent()
    const id = await h.create({ codingSteps: 10 })
    const reserved = orch()['reserve_bytes']
    expect(orch()['coding_reserve_bytes']).toBe(10 * CODING_ITEM_EXTRA_BYTES)
    await h.orch.limits(id, { codingSteps: 4, orchestrationRevision: revision(id) })
    expect(orch()['coding_reserve_bytes']).toBe(10 * CODING_ITEM_EXTRA_BYTES)
    await h.orch.limits(id, { codingSteps: 10, orchestrationRevision: revision(id) })
    expect(orch()['coding_steps']).toBe(10)
    expect(orch()['reserve_bytes']).toBe(reserved)
    expect(orch()['coding_reserve_bytes']).toBe(10 * CODING_ITEM_EXTRA_BYTES)
  })

  test('raising codingSteps grows the reserve by the new items; a database without room refuses it', async () => {
    // The database holds exactly what a default run (10 coding items) reserves, which is also what preflight asks for.
    const quota = reserveFor(12, 20, codingItemsFor(12, 10))
    h = await workerHarness({
      lead: {
        script: byTurn({
          1: async () => 'waiting',
          2: async () => 'waiting',
          3: async () => 'waiting',
        }),
      },
      orchestrator: { quotaBytes: quota },
    })
    h.addAgent()
    const id = await h.create({ codingSteps: 4 })
    const base = reserveFor(12, 20, codingItemsFor(12, 4))
    expect(orch()['reserve_bytes']).toBe(base)
    expect(orch()['coding_reserve_bytes']).toBe(4 * CODING_ITEM_EXTRA_BYTES)
    await h.orch.limits(id, { codingSteps: 6, orchestrationRevision: revision(id) })
    expect(orch()['reserve_bytes']).toBe(base + 2 * CODING_ITEM_EXTRA_BYTES)
    expect(orch()['coding_reserve_bytes']).toBe(6 * CODING_ITEM_EXTRA_BYTES)
    // Six more items (12 in all) are more than the database has room for.
    await expect(
      h.orch.limits(id, { codingSteps: 12, orchestrationRevision: revision(id) }),
    ).rejects.toMatchObject({ status: 409, code: 'quota_exhausted' })
    expect(orch()['coding_steps']).toBe(6)
    expect(orch()['reserve_bytes']).toBe(base + 2 * CODING_ITEM_EXTRA_BYTES)
  })
})
