import { afterEach, expect, test } from 'vitest'
import { byTurn } from '../../src/hermes/fake/fake-lead.ts'
import { workerHarness, type WorkerHarness } from '../helpers/worker-harness.ts'

// 7.7b-1: the executor ↔ coding runtime core, through the real Orchestrator, CodingRuntime, UnitBackend, journal and
// supervisor; only systemd is faked.

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
const oneStep = (instruction: string) =>
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
