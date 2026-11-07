import { describe, expect, test } from 'vitest'
import { workerHarness, type WorkerHarness } from '../helpers/worker-harness.ts'
import {
  attempt,
  atArming,
  closed,
  gens,
  oneStep,
  sql,
  useWorkerHarness,
} from './coding-workers-helpers.ts'

// 7.7b-F1: regression tests for the code review of 2026-10-14 (docs/reviews/2026-10-14-7.7b-code-review.md). Each test
// is that review's probe, written to fail on the code the review found.

let h: WorkerHarness
useWorkerHarness(
  () => h,
  () => {
    h = undefined as never
  },
)

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
      await h.create({ budgetUsd: 5, ...(extra as { acceptUnknownCost?: 'hermes'[] }) })
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
