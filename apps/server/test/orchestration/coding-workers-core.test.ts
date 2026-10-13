import { afterEach, vi, expect, test } from 'vitest'
import { budgetView } from '../../src/domain/orchestration/budget.ts'
import { readOrch } from '../../src/domain/orchestration/store.ts'
import { byTurn } from '../../src/hermes/fake/fake-lead.ts'
import { workerHarness, type WorkerHarness } from '../helpers/worker-harness.ts'

// 7.7b-1: the executor ↔ coding runtime core, through the real Orchestrator, CodingRuntime, UnitBackend, journal and
// supervisor; only systemd is faked.

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 })

let h: WorkerHarness
afterEach(async () => {
  await h?.close()
  h = undefined as never
})

const status = (id: string) => h.orch.summary(id).status
const attempts = () =>
  h.rows<Record<string, unknown>>("SELECT * FROM orc_attempts WHERE kind = 'step' ORDER BY n")
const launches = () =>
  h.rows<Record<string, unknown>>('SELECT * FROM coding_launches ORDER BY updated_at')

/** A lead that assigns one coding step in its first turn and finishes once it is done. */
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

test('smoke: a coding step is dispatched, released, completed and its complete reply feeds the lead', async () => {
  h = await workerHarness({ lead: { script: oneStep('[fixture:basic] write hello') } })
  h.addAgent()
  const id = await h.create()
  await h.until(() => status(id) === 'succeeded', 40_000)
  const [attempt] = attempts()
  expect(attempt).toMatchObject({
    state: 'terminated',
    evidence: 'completed',
    runtime: 'claude-code',
  })
  expect(String(attempt!['result_text'])).toContain('Created hello.txt and changed it.')
  expect(launches()).toHaveLength(1)
  expect(h.errors).toEqual([])
})

test('a hold at release closes generation 1 (send_closed, cause paused); generation 2 has its own turn, launch and run', async () => {
  h = await workerHarness({
    lead: { script: oneStep('[fixture:basic] write hello') },
    // The part-2 hook seat: consulted at the ordering point, after the common admission rules.
    orchestrator: {
      releaseChecks: {
        limits: (_sqlite, subject) => (subject.generation === 1 ? 'paused' : undefined),
      },
    },
  })
  h.addAgent()
  const id = await h.create()
  await h.until(() => status(id) === 'succeeded', 40_000)
  const gens = h.rows<Record<string, unknown>>('SELECT * FROM orc_generations ORDER BY generation')
  expect(gens).toHaveLength(2)
  expect(gens[0]).toMatchObject({ generation: 1, closed_cause: 'paused' })
  expect(gens[1]!['closed_cause']).toBeNull()
  expect(new Set(gens.map((g) => g['turn_id'])).size).toBe(2)
  expect(new Set(gens.map((g) => g['launch_id'])).size).toBe(2)
  expect(gens[1]!['turn_id']).toBe(`${attempts()[0]!['turn_id'] as string}:g2`)
  // Generation 1's launch was revoked at the ordering point with its typed cause; it never ran. Its owner is permanent.
  const [first, second] = launches()
  expect(first).toMatchObject({
    launch_id: gens[0]!['launch_id'],
    revoked: 1,
    may_have_executed: 0,
    revoke_cause: 'paused',
    owner_orchestration: id,
    owner_attempt: attempts()[0]!['id'],
    owner_generation: 1,
  })
  expect(second).toMatchObject({ may_have_executed: 1, revoked: 0, owner_generation: 2 })
  // Two runs, one per generation; the attempt's handle is generation 2's and generation 1's stays as evidence only.
  const runs = h.rows<{ id: string; score_turn_id: string; status: string }>(
    "SELECT id, score_turn_id, status FROM runs WHERE runtime != 'hermes' ORDER BY started_at, rowid",
  )
  expect(runs.map((r) => r.score_turn_id)).toEqual(gens.map((g) => g['turn_id']))
  expect(attempts()[0]!['run_id']).toBe(runs[1]!.id)
  expect(gens[0]!['run_id']).toBe(runs[0]!.id)
  // The refusal counters were never touched; the journal has the closure and both handles with their generation.
  expect(attempts()[0]).toMatchObject({
    refused_total: 0,
    refused_streak: 0,
    dispatch_generation: 2,
  })
  const read = h.journal.readOwn()
  if (!read.ok) throw new Error(read.reason)
  expect(read.entries.filter((e) => e.kind === 'send_closed')).toMatchObject([
    { generation: 1, cause: 'paused' },
  ])
  expect(
    read.entries
      .filter((e) => e.kind === 'run_handle' && e.attemptId === attempts()[0]!['id'])
      .map((e) => (e as { generation?: number }).generation),
  ).toEqual([1, 2])
  const sends = read.entries.filter(
    (e) => e.kind === 'send_started' && e.attemptId === attempts()[0]!['id'],
  ) as unknown as {
    turnId: string
    launchId: string
  }[]
  expect(sends.map((e) => [e.turnId, e.launchId])).toEqual(
    gens.map((g) => [g['turn_id'], g['launch_id']]),
  )
  // Generation 1's run ended failed without ever launching; generation 2's own reply row carries the answer.
  expect(runs.map((r) => r.status)).toEqual(['failed', 'completed'])
  const replies = h.rows<{ generation: number; message_id: string; run_id: string }>(
    'SELECT generation, message_id, run_id FROM message_runs WHERE orchestration_attempt_id IS NOT NULL AND generation IS NOT NULL ORDER BY generation',
  )
  expect(replies.map((r) => r.run_id)).toEqual(runs.map((r) => r.id))
  expect(new Set(replies.map((r) => r.message_id)).size).toBe(2)
  expect(h.errors).toEqual([])
})

const lastLeadInput = () =>
  h.rows<{ input: string }>(
    "SELECT input FROM orc_attempts WHERE kind = 'lead' ORDER BY n DESC LIMIT 1",
  )[0]!.input

test('result_text is the complete eligible reply: no 8 KiB display cut, no annotation, and the lead is fed from it', async () => {
  h = await workerHarness({ lead: { script: oneStep('[fixture:bigreply] write the report') } })
  h.addAgent()
  const id = await h.create()
  await h.until(() => status(id) === 'succeeded', 40_000)
  const reply = `START-${'v'.repeat(20000)}-END`
  const [attempt] = attempts()
  expect(attempt!['result_text']).toBe(reply)
  expect(attempt!['result_truncated']).toBe(0)
  // The run record keeps its 8 KiB display cut; the worker's result does not.
  const run = h.rows<{ output: string }>("SELECT output FROM runs WHERE runtime != 'hermes'")[0]!
  expect(Buffer.byteLength(run.output)).toBeLessThanOrEqual(8192)
  const step = h.rows<{ result: string }>('SELECT result FROM orc_steps')[0]!
  expect(step.result).toBe(reply)
  // The lead's next turn saw the whole result.
  expect(lastLeadInput()).toContain(reply)
})

test('a reply over 32 KiB is stored cut at a character boundary, flagged, and the lead is told', async () => {
  h = await workerHarness({ lead: { script: oneStep('[fixture:hugereply] write the report') } })
  h.addAgent()
  const id = await h.create()
  await h.until(() => status(id) === 'succeeded', 40_000)
  const [attempt] = attempts()
  expect(attempt!['result_truncated']).toBe(1)
  expect(Buffer.byteLength(attempt!['result_text'] as string)).toBeLessThanOrEqual(32 * 1024)
  expect((attempt!['result_text'] as string).startsWith('START-vvvv')).toBe(true)
  expect(h.rows<{ result: string }>('SELECT result FROM orc_steps')[0]!.result).toContain(
    'cut at 32 KiB by Score',
  )
  expect(lastLeadInput()).toContain('cut at 32 KiB by Score')
})

test('a run that ends without a recorded cost counts as unknown cost, and pauses a run with a dollar budget', async () => {
  h = await workerHarness({
    lead: {
      script: byTurn({
        1: async (t) => {
          await t.call('orch.assign', {
            agent: 'coder',
            instruction: '[fixture:basic] write hello',
          })
          return 'assigned'
        },
        2: async (t) => {
          await t.call('orch.finish', { outcome: 'success', summary: 'done' })
        },
      }),
    },
  })
  // Codex reports tokens but no dollar cost.
  h.addAgent('coder', 'codex')
  const id = await h.create({ budgetUsd: 5 })
  await h.until(() => h.orch.summary(id).pauseReason === 'unknown_spend', 40_000)
  expect(attempts()[0]).toMatchObject({
    state: 'terminated',
    evidence: 'completed',
    spend_usd: null,
  })
  expect(h.db.read((sqlite) => budgetView(sqlite, readOrch(sqlite, id)!)).unknownSpend).toBe(true)
})

test('end proof is required: an unproven end is unknown (agent fenced); the late proof settles it and its result is never used', async () => {
  h = await workerHarness({ lead: { script: oneStep('[fixture:basic] write hello') } })
  h.addAgent()
  let held: { forcePopulated?: boolean } | undefined
  // A survivor outside the supervisor's reach keeps the unit's cgroup populated, so the end can't be proven.
  h.fake.hooks.afterStart = (unit) => {
    held = unit
    unit.forcePopulated = true
  }
  const id = await h.create()
  await h.until(() => attempts()[0]?.['state'] === 'unknown', 40_000)
  expect(attempts()[0]).toMatchObject({ unknown_reason: 'run_not_proven_ended', result_text: null })
  expect(h.rows<{ status: string }>('SELECT status FROM orc_steps')[0]!.status).toBe('unknown')
  expect(status(id)).toBe('running')
  // The proof arrives later.
  held!.forcePopulated = false
  await h.until(() => attempts()[0]?.['state'] === 'terminated', 40_000)
  // Obligations are closed and accounting settled; the answer is permanently non-consumable.
  expect(attempts()[0]).toMatchObject({ result_text: null, settled: 1 })
  expect(
    h.rows<{ status: string; result: string | null }>('SELECT status, result FROM orc_steps')[0],
  ).toMatchObject({
    status: 'failed',
    result: null,
  })
  expect(
    h.rows<{ detail: string }>("SELECT detail FROM orc_history WHERE kind = 'late_result'"),
  ).toHaveLength(1)
})

test('one launch per generation: an owned turn never resumes a CLI session and has no resume fallback', async () => {
  h = await workerHarness({ lead: { script: oneStep('[fixture:stale] answer once') } })
  h.addAgent()
  // The orchestration's room already has a (dead) CLI session for the agent: a Chat turn would resume it first, be
  // refused, and launch a second time. An owned turn must start fresh and launch once.
  h.db.sqlite.exec(`CREATE TRIGGER seed_session AFTER INSERT ON rooms BEGIN
    INSERT INTO coding_sessions (room_id, agent_id, session_id, updated_at)
    VALUES (NEW.id, 'coder', 'dead-session', '2026-01-01T00:00:00.000Z'); END`)
  const id = await h.create()
  await h.until(() => status(id) === 'succeeded', 40_000)
  expect(h.cliCalls()).toHaveLength(1)
  expect(h.cliCalls()[0]!.args).not.toContain('--resume')
  expect(launches()).toHaveLength(1)
  expect(attempts()[0]).toMatchObject({ state: 'terminated', evidence: 'completed' })
})

test('a readiness refusal is a send_refused (counted); the redispatch is a new generation and the streak resets only on a release', async () => {
  let refuse = true
  h = await workerHarness({
    lead: { script: oneStep() },
    orchestrator: {
      releaseChecks: {
        limits: (_s, subject) => (refuse && subject.generation === 1 ? 'cli_missing' : undefined),
      },
    },
  })
  h.addAgent()
  const id = await h.create()
  await h.until(() => status(id) === 'succeeded', 40_000)
  refuse = false
  const [a] = attempts()
  expect(a).toMatchObject({ refused_total: 1, refused_streak: 0, dispatch_generation: 2 })
  const read = h.journal.readOwn()
  if (!read.ok) throw new Error(read.reason)
  expect(read.entries.filter((e) => e.kind === 'send_refused')).toHaveLength(1)
  expect(read.entries.filter((e) => e.kind === 'send_closed')).toHaveLength(0)
  const gens = h.rows<Record<string, unknown>>('SELECT * FROM orc_generations ORDER BY generation')
  expect(gens.map((g) => g['closed_cause'])).toEqual(['cli_missing', null])
  // A new turn and launch id; generation 2's run is the attempt's handle, generation 1's is evidence only.
  expect(new Set(gens.map((g) => g['turn_id'])).size).toBe(2)
  expect(a!['run_id']).toBe(gens[1]!['run_id'])
  expect(gens[0]!['run_id']).not.toBe(gens[1]!['run_id'])
})

test('five readiness refusals in a row make the attempt wait; the readiness wake-up sends it again', async () => {
  let cause: string | undefined = 'untested_version'
  h = await workerHarness({
    lead: { script: oneStep() },
    orchestrator: { releaseChecks: { limits: () => cause } },
  })
  h.addAgent()
  const id = await h.create()
  await h.until(() => (attempts()[0]?.['refused_streak'] as number) >= 5, 40_000)
  await h.until(() => attempts()[0]?.['next_try_at'] !== null)
  expect(attempts()[0]).toMatchObject({ state: 'created', needs_person: 0, refused_total: 5 })
  cause = undefined
  await h.orch.agentReady('coder')
  await h.until(() => status(id) === 'succeeded', 40_000)
  expect(attempts()[0]).toMatchObject({ state: 'terminated', refused_streak: 0, refused_total: 5 })
})

test('past 20 generations the step is blocked "kept being held back" for the person; there is no automatic loop', async () => {
  h = await workerHarness({
    lead: { script: oneStep() },
    // Every dispatch is refused before the run is queued (a coding fence), 20 times over.
    unit: { blocked: () => 'A fence is up.' },
    orchestrator: { retryMs: 20 },
  })
  h.addAgent()
  await h.create()
  await h.until(() => attempts()[0]?.['state'] === 'refused', 60_000)
  expect(h.rows('SELECT generation FROM orc_generations')).toHaveLength(20)
  expect(attempts()[0]).toMatchObject({
    state: 'refused',
    dispatch_generation: 20,
    refused_total: 0,
  })
  expect(
    h.rows<{ status: string; disposition: string }>('SELECT status, disposition FROM orc_steps')[0],
  ).toMatchObject({
    status: 'blocked',
    disposition: expect.stringContaining('kept being held back'),
  })
  const closures = h.journal.readOwn()
  if (!closures.ok) throw new Error(closures.reason)
  expect(closures.entries.filter((e) => e.kind === 'send_closed')).toHaveLength(20)
  // Nothing is sent after that, however long the executor keeps pumping.
  await h.orch.admissionChanged()
  await h.orch.idle()
  expect(h.rows('SELECT generation FROM orc_generations')).toHaveLength(20)
})
