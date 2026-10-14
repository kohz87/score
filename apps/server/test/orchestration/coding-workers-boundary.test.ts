import { afterEach, expect, test, vi } from 'vitest'
import { codingProjection } from '../../src/domain/orchestration/coding-checkpoint.ts'
import { CodingJournal } from '../../src/domain/orchestration/coding-journal.ts'
import { byTurn } from '../../src/hermes/fake/fake-lead.ts'
import { workerHarness, type WorkerHarness } from '../helpers/worker-harness.ts'

// 7.7b-1 #5/#7: transaction ownership at the ordering point, fault injection around the projection commit, Stop of
// queued and running coding steps, and pruning by generation identity.

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

test('release inside a caller’s transaction throws and writes nothing; outside one it works', async () => {
  h = await workerHarness({ lead: { script: oneStep() } })
  const journal = new CodingJournal(h.journal, () => h.db.sqlite.isTransaction)
  const project = codingProjection(h.db)
  const id = { launchId: 'l1', runId: 'r1', turnId: 't1', generation: 1 }
  expect(journal.requestLaunch(id, project).ok).toBe(true)
  expect(journal.arm('l1', { unit: 'u', invocationId: 'i', cgroup: '/cg' }, project).ok).toBe(true)
  expect(() =>
    h.db.tx(() => journal.releaseOwned('l1', () => ({ allowed: true }), project)),
  ).toThrow(/never released inside a database transaction/)
  // Nothing was appended: the launch is still armed and may still be revoked.
  expect(journal.state('l1')!.state).toMatchObject({ phase: 'armed', mayHaveExecuted: false })
  expect(journal.releaseOwned('l1', () => ({ allowed: true }), project).ok).toBe(true)
  expect(journal.state('l1')!.state.mayHaveExecuted).toBe(true)
})

test('a "no" at the ordering point writes the revoke tombstone with its cause in the same critical section', async () => {
  h = await workerHarness({ lead: { script: oneStep() } })
  const journal = new CodingJournal(h.journal)
  const project = codingProjection(h.db)
  journal.requestLaunch({ launchId: 'l2', runId: 'r2', turnId: 't2', generation: 1 }, project)
  journal.arm('l2', { unit: 'u', invocationId: 'i', cgroup: '/cg' }, project)
  const result = journal.releaseOwned('l2', () => ({ allowed: false, cause: 'paused' }), project)
  expect(result).toMatchObject({ ok: false, reason: 'not_authorised', denied: 'paused' })
  expect(journal.state('l2')!.state).toMatchObject({
    revoked: true,
    revokeCause: 'paused',
    mayHaveExecuted: false,
  })
  expect(h.rows("SELECT revoke_cause FROM coding_launches WHERE launch_id = 'l2'")).toEqual([
    { revoke_cause: 'paused' },
  ])
})

test('projection failure after releasing: no go reaches the CLI, the launch stays "may have executed", the attempt is unknown (never send_refused)', async () => {
  h = await workerHarness({ lead: { script: oneStep() } })
  h.addAgent()
  // The database refuses every projection from `releasing` on, after the journal record is already durable.
  h.db.sqlite.exec(`CREATE TRIGGER no_release BEFORE UPDATE ON coding_launches
    WHEN NEW.phase IN ('releasing', 'released', 'ended', 'settled')
    BEGIN SELECT RAISE(ABORT, 'disk full'); END`)
  const id = await h.create()
  await h.until(() => attempts()[0]?.['state'] === 'unknown', 40_000)
  expect(h.cliCalls()).toHaveLength(0)
  const read = h.journal.readOwn()
  if (!read.ok) throw new Error(read.reason)
  const kinds = read.entries.filter((e) => 'launchId' in e).map((e) => e.kind)
  expect(kinds).toContain('releasing')
  expect(
    read.entries.filter((e) => e.kind === 'send_refused' || e.kind === 'send_closed'),
  ).toHaveLength(0)
  expect(attempts()[0]).toMatchObject({ unknown_reason: 'run_not_proven_ended', refused_total: 0 })
  expect(status(id)).toBe('running')
})

test('Stop: a queued step is cancelled with known-zero spend, a running one is stopped and proven ended', async () => {
  h = await workerHarness({
    lead: {
      script: byTurn({
        1: async (t) => {
          await t.call('orch.assign', { agent: 'coder', instruction: '[fixture:slow] stay busy' })
          await t.call('orch.assign', {
            agent: 'coder',
            instruction: '[fixture:basic] wait your turn',
          })
          return 'assigned'
        },
        2: async () => 'waiting',
      }),
    },
  })
  h.addAgent()
  const id = await h.create()
  // The first step holds the agent's only turn slot; the second one is admitted and queued behind it.
  await h.until(
    () => attempts().length === 2 && attempts().every((a) => a['state'] === 'running'),
    40_000,
  )
  await h.until(() => h.cliCalls().length === 1)
  await h.orch.stop(id)
  await h.until(() => status(id) === 'stopped', 40_000)
  const [running, queued] = attempts()
  expect(running).toMatchObject({ state: 'terminated' })
  expect(queued).toMatchObject({
    state: 'terminated',
    evidence: null,
    spend_usd: 0,
    settled: 1,
    reserved_usd: 0,
  })
  // Only the first step ever launched; its unit ended with proof.
  expect(launches()).toHaveLength(1)
  expect(launches()[0]).toMatchObject({ may_have_executed: 1 })
  expect(h.cliCalls()).toHaveLength(1)
  expect(h.errors).toEqual([])
})

test('pruning an orchestration with coding steps removes every generation’s rows and keeps launch rows; a restart then finds no fence', async () => {
  h = await workerHarness({
    lead: { script: oneStep() },
    orchestrator: {
      releaseChecks: { limits: (_s, subject) => (subject.generation === 1 ? 'hold' : undefined) },
    },
  })
  h.addAgent()
  const id = await h.create()
  await h.until(() => status(id) === 'succeeded', 40_000)
  const launchRows = launches().length
  expect(launchRows).toBe(2)
  h.db.sqlite.prepare("UPDATE orchestrations SET ended_at = '2020-01-01T00:00:00.000Z'").run()
  const out = h.orch.maintenance()
  expect(out.pruned).toBe(1)
  expect(h.rows('SELECT 1 FROM orc_generations')).toHaveLength(0)
  expect(h.rows("SELECT 1 FROM runs WHERE runtime != 'hermes'")).toHaveLength(0)
  expect(h.rows('SELECT 1 FROM coding_run_results')).toHaveLength(0)
  expect(h.rows('SELECT 1 FROM message_runs WHERE generation IS NOT NULL')).toHaveLength(0)
  // The launches stay as the permanent witnesses.
  expect(launches()).toHaveLength(launchRows)
  await h.restart()
  expect(h.fence.view().fenced).toBe(false)
  expect(h.rows('SELECT 1 FROM orc_generations')).toHaveLength(0)
  expect(h.rows('SELECT 1 FROM orc_attempts')).toHaveLength(0)
  expect(launches()).toHaveLength(launchRows)
})
