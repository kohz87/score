import { afterEach, expect, test } from 'vitest'
import { makeSpendReader, runSpendReader, spendEvidence } from '../../src/domain/orchestration/budget.ts'
import { planWorkflow } from '../../src/domain/workflows/planner.ts'
import { readOrch, type AttemptRow } from '../../src/domain/orchestration/store.ts'
import { attemptsOf } from '../../src/domain/orchestration/store.ts'
import {
  agent,
  definition,
  edge,
  end,
  endRun,
  node,
  run,
  runIdOf,
  start,
  wfHarness,
  type Harness,
} from './wf-harness.ts'

let h: Harness | undefined
afterEach(async () => {
  await h?.close()
  h = undefined
})
const done = (id: string, status = 'succeeded') => (): boolean => run(h!, id).status === status
const simple = () => definition([agent('a'), end()], [edge('a', 'done')])
const commands = (id: string) =>
  h!.rows<{ attempt: number; generation: number; outcome: string }>(
    "SELECT attempt, generation, outcome FROM wf_commands WHERE orchestration_id = ? AND verb = 'assign'",
    id,
  )

test('a budget refusal waits (no stored refusal), then a raised budget assigns under a new generation', async () => {
  h = await wfHarness()
  const id = await start(h, simple(), { budgetUsd: 0.3 })
  await h.settle(3000)
  expect(node(h, id, 'a').state).toBe('ready')
  expect(node(h, id, 'a').waitingFor).toBe('budget')
  expect(commands(id)).toEqual([])
  // A ready node that waits is a wake source: the run is not paused "no_wake_source".
  await h.settle(15_000)
  expect(run(h, id).status).toBe('running')
  const before = run(h, id).plannerGeneration
  await h.orch.wfLimits(id, { budgetUsd: 5, orchestrationRevision: run(h, id).revision })
  await h.until(done(id))
  expect(run(h, id).plannerGeneration).toBeGreaterThan(before)
  expect(commands(id)).toEqual([{ attempt: 1, generation: run(h, id).plannerGeneration, outcome: 'ok' }])
  expect(h.rows('SELECT 1 FROM wf_commands WHERE outcome = ?', 'refused')).toHaveLength(0)
})

test('unknown spend with a budget waits for the person unless the run chose to continue', async () => {
  h = await wfHarness({ orchestrator: { spend: () => ({ usd: null, complete: false }) } })
  const id = await start(
    h,
    definition([agent('a'), agent('b'), end()], [edge('a', 'b'), edge('b', 'done')]),
    { budgetUsd: 50 },
  )
  await h.until(() => node(h!, id, 'a').state === 'succeeded')
  await h.settle(5000)
  expect(node(h, id, 'b').waitingFor).toBe('unknown_spend')
  expect(run(h, id).budget.unknownSpend).toBe(true)
  await h.orch.wfLimits(id, { acceptUnknownSpend: true, orchestrationRevision: run(h, id).revision })
  await h.until(done(id))
})

test('a deadline acts as Stop: the run drains and ends stopped', async () => {
  h = await wfHarness()
  const id = await start(h, definition([agent('a', { instruction: '[fake:hold] A' }), end()], [edge('a', 'done')]), {
    deadlineAt: new Date(h.scheduler.now() + 60_000).toISOString(),
  })
  await h.until(() => runIdOf(h!, id, 'a') !== undefined)
  await h.settle(65_000)
  expect(run(h, id).status).toBe('stopping')
  const attempt = run(h, id).attempts[0]!
  await h.until(() => run(h!, id).attempts[0]!.state === 'unknown')
  await endRun(h, attempt.runId!, 'completed', 'late')
  await h.until(done(id, 'stopped'))
  expect(run(h, id).graphOutcome).toBe('stopped')
  expect(run(h, id).endReason).toBe('deadline expired')
})

test('there are no per-node deadlines: only the run deadline exists', () => {
  const node = agent('a') as Record<string, unknown>
  expect(Object.keys(node)).not.toContain('deadlineMin')
})

test('the planner pass is idempotent and atomic: a rolled-back pass leaves nothing, and the retry creates exactly one assignment', async () => {
  h = await wfHarness()
  // Stop the executor from racing the test, then drive the planner by hand.
  await h.orch.close()
  const id = await start(h, simple(), { budgetUsd: 0.3 })
  expect(node(h, id, 'a').state).toBe('ready')
  h.db.sqlite.prepare('UPDATE orchestrations SET budget_usd = 10 WHERE id = ?').run(id)
  const o = () => readOrch(h!.db.sqlite, id)!
  const counts = () => ({
    steps: h!.rows<{ n: number }>('SELECT COUNT(*) AS n FROM orc_steps')[0]!.n,
    commands: h!.rows<{ n: number }>('SELECT COUNT(*) AS n FROM wf_commands')[0]!.n,
    tokens: h!.rows<{ n: number }>('SELECT COUNT(*) AS n FROM wf_tokens')[0]!.n,
  })
  const ctx = (sqlite: Parameters<Parameters<Harness['db']['tx']>[0]>[0]) => ({
    sqlite,
    now: new Date(h!.scheduler.now()).toISOString(),
    journal: h!.journal,
    touched: new Set<string>(),
    events: [],
  })
  const before = counts()
  expect(() =>
    h!.db.tx((sqlite) => {
      planWorkflow(ctx(sqlite), o())
      throw new Error('crash before the commit')
    }),
  ).toThrow('crash')
  expect(counts()).toEqual(before)
  expect(node(h, id, 'a').state).toBe('ready')
  // The re-derived pass creates the same command once; repeating it changes nothing.
  h.db.tx((sqlite) => planWorkflow(ctx(sqlite), o()))
  const after = counts()
  expect(after.steps).toBe(1)
  expect(after.commands).toBe(1)
  h.db.tx((sqlite) => planWorkflow(ctx(sqlite), o()))
  h.db.tx((sqlite) => planWorkflow(ctx(sqlite), o()))
  expect(counts()).toEqual(after)
  expect(commands(id)).toEqual([{ attempt: 1, generation: 0, outcome: 'ok' }])
})

// -------------------------------------------------------------------------------------------- spend evidence

const insertRun = (harness: Harness, over: Record<string, unknown>) => {
  const row = {
    id: 'r1',
    profile: 'builder',
    status: 'completed',
    session_id: 'sess-1',
    cost_usd: null as number | null,
    input_tokens: null as number | null,
    output_tokens: null as number | null,
    ...over,
  }
  harness.db.sqlite
    .prepare(
      `INSERT INTO runs (id, profile, origin, status, session_id, cost_usd, input_tokens, output_tokens, started_at, updated_at, ended_at)
       VALUES (?, ?, 'score', ?, ?, ?, ?, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    )
    .run(
      row.id as string,
      row.profile as string,
      row.status as string,
      row.session_id as string,
      row.cost_usd as number | null,
      row.input_tokens as number | null,
      row.output_tokens as number | null,
    )
  return { run_id: row.id } as unknown as AttemptRow
}

test('spend: the real token-only Hermes payload is never a settled dollar figure', async () => {
  h = await wfHarness()
  // usage from the recorded l4a run: tokens, no cost.
  const attempt = insertRun(h, { id: 'real', input_tokens: 38465, output_tokens: 202 })
  expect(spendEvidence(h.db.sqlite, attempt, true)).toEqual({
    attributed: true,
    lineageComplete: true,
    fresh: true,
    costScope: 'tokens',
  })
  expect(runSpendReader(h.db.sqlite, attempt)).toEqual({ usd: null, complete: false })
})

test('spend: a missing continuation (a sibling run in the session is open) keeps spend provisional', async () => {
  h = await wfHarness()
  const attempt = insertRun(h, { id: 'main', cost_usd: 0.4 })
  expect(runSpendReader(h.db.sqlite, attempt).complete).toBe(true)
  insertRun(h, { id: 'continuation', status: 'running' })
  expect(spendEvidence(h.db.sqlite, attempt, true).lineageComplete).toBe(false)
  expect(runSpendReader(h.db.sqlite, attempt).complete).toBe(false)
})

test('spend: delayed cost is not settled until a dollar figure arrives', async () => {
  h = await wfHarness()
  const attempt = insertRun(h, { id: 'late', input_tokens: 10, output_tokens: 2 })
  expect(runSpendReader(h.db.sqlite, attempt).complete).toBe(false)
  h.db.sqlite.prepare('UPDATE runs SET cost_usd = 0.2 WHERE id = ?').run('late')
  expect(runSpendReader(h.db.sqlite, attempt)).toEqual({ usd: 0.2, complete: true })
})

test('spend: live Hermes spend is never settled, whatever the run record says', async () => {
  h = await wfHarness()
  const attempt = insertRun(h, { id: 'live', cost_usd: 0.4 })
  expect(makeSpendReader(true)(h.db.sqlite, attempt)).toEqual({ usd: 0.4, complete: false })
  expect(makeSpendReader(false)(h.db.sqlite, attempt)).toEqual({ usd: 0.4, complete: true })
})

test('a run reports its evidence and says spend is not settled when it cannot prove completeness', async () => {
  h = await wfHarness()
  const id = await start(h, simple())
  await h.until(done(id))
  const spend = run(h, id).spend
  expect(spend.evidence).toHaveLength(1)
  expect(spend.evidence[0]).toMatchObject({ attributed: true, costScope: 'dollars' })
  expect(attemptsOf(h.db.sqlite, id)[0]!.settled).toBe(true)
  // The fake adapter can prove lineage, so it settles; the note says so honestly in both cases.
  expect(spend.settled).toBe(true)
})
