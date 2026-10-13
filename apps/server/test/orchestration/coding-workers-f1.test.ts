import { afterEach, vi, describe, expect, test } from 'vitest'
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
