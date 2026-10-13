import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { budgetView } from '../../src/domain/orchestration/budget.ts'
import { applyJournalEvidence, verifyJournal } from '../../src/domain/orchestration/fence.ts'
import { ExecutionJournal, journalDispatches } from '../../src/domain/orchestration/journal.ts'
import { readOrch } from '../../src/domain/orchestration/store.ts'
import { byTurn } from '../../src/hermes/fake/fake-lead.ts'
import { tempDir } from './harness-db.ts'
import { workerHarness, type WorkerHarness } from '../helpers/worker-harness.ts'

// 7.7b-1 #2/#5: older generations are evidence only, the journal's closure is applied after a crash, compaction keeps
// the dispatch word, a suspended attempt owns its reservation, and the supervisor's expiry never outlives the deadline.

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 })

let h: WorkerHarness
afterEach(async () => {
  await h?.close()
  h = undefined as never
})

const oneStep = () =>
  byTurn({
    1: async (t) => {
      await t.call('orch.assign', { agent: 'coder', instruction: '[fixture:basic] write hello' })
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
const entries = () => {
  const read = h.journal.readOwn()
  if (!read.ok) throw new Error(read.reason)
  return read.entries
}
const verify = () => verifyJournal(h.db.sqlite, entries())

test('an older generation’s handle is evidence only: replay attaches the current generation’s run and never the older one', async () => {
  h = await workerHarness({
    lead: { script: oneStep() },
    orchestrator: {
      releaseChecks: { limits: (_s, subject) => (subject.generation === 1 ? 'hold' : undefined) },
    },
  })
  h.addAgent()
  const id = await h.create()
  await h.until(() => h.orch.summary(id).status === 'succeeded', 40_000)
  const [g1, g2] = gens()
  expect(g1!['run_id']).not.toBe(g2!['run_id'])
  // Verification of a healthy database finds nothing wrong with the older handle.
  expect(verify()).toEqual([])
  // A database that lost the attempt's handle gets the CURRENT generation's back, and the older one stays on its row.
  h.db.sqlite.prepare("UPDATE orc_attempts SET run_id = NULL WHERE kind = 'step'").run()
  h.db.sqlite.prepare("UPDATE orc_attempts SET state = 'running' WHERE kind = 'step'").run()
  applyJournalEvidence(h.db.sqlite, entries(), new Date().toISOString())
  expect(attempt()['run_id']).toBe(g2!['run_id'])
  expect(gens()[0]!['run_id']).toBe(g1!['run_id'])
})

test('a closure the journal holds but the database lost is detected and finished without touching the refusal counters', async () => {
  h = await workerHarness({ lead: { script: oneStep() } })
  h.addAgent()
  h.fake.hooks.afterStart = () => {
    h.fake.hooks.afterStart = undefined
    h.db.sqlite.prepare('UPDATE orc_attempts SET retired = 1').run()
  }
  const id = await h.create()
  await h.until(() => attempt()['state'] === 'terminated', 40_000)
  expect(gens()[0]!['closed_cause']).toBe('retired')
  // Rewind the database to just before the closure was committed (the journal is outside the restorable home).
  const sql = (text: string) => h.db.sqlite.prepare(text).run()
  sql(
    "UPDATE orc_attempts SET state = 'running', terminated_at = NULL, settled = 0, spend_usd = NULL, spend_complete = 0, reserved_usd = 0.5 WHERE kind = 'step'",
  )
  sql("UPDATE orc_steps SET status = 'admitted', disposition = NULL")
  sql('UPDATE orc_generations SET closed_cause = NULL, closed_at = NULL')
  const detected = verify().filter((m) => m.kind === 'attempt')
  expect(detected.map((m) => m.detail).join(' ')).toContain('closed')
  applyJournalEvidence(h.db.sqlite, entries(), new Date().toISOString())
  expect(attempt()).toMatchObject({
    state: 'terminated',
    refused_total: 0,
    spend_usd: 0,
    settled: 1,
  })
  expect(gens()[0]!['closed_cause']).toBe('retired')
  expect(h.rows<{ status: string }>('SELECT status FROM orc_steps')[0]!.status).toBe('cancelled')
  expect(readOrch(h.db.sqlite, id)).toBeDefined()
})

test('compaction folds an older closed generation into a witness and keeps the latest dispatch word', () => {
  const tmp = tempDir('closed-journal-')
  try {
    const journal = new ExecutionJournal(join(tmp.dir, 'ns'), 'scope-a')
    const base = {
      attemptId: 'a1',
      orchestrationId: 'o1',
      attemptKind: 'step' as const,
      agentId: 'coder',
    }
    journal.append({ kind: 'send_started', ...base, generation: 1, turnId: 't:g1', launchId: 'l1' })
    journal.append({
      kind: 'send_closed',
      attemptId: 'a1',
      orchestrationId: 'o1',
      generation: 1,
      cause: 'paused',
    })
    journal.append({ kind: 'send_started', ...base, generation: 2, turnId: 't:g2', launchId: 'l2' })
    journal.compact(() => false)
    const read = journal.readOwn()
    if (!read.ok) throw new Error(read.reason)
    expect(journalDispatches(read.entries).get('a1')).toMatchObject({
      generation: 2,
      state: 'sent',
    })
    // Ending on a closed generation, the closure survives as a witness (and counts as unsent, not as a refusal).
    journal.append({
      kind: 'send_closed',
      attemptId: 'a1',
      orchestrationId: 'o1',
      generation: 2,
      cause: 'stop',
    })
    journal.compact(() => false)
    const again = journal.readOwn()
    if (!again.ok) throw new Error(again.reason)
    expect(journalDispatches(again.entries).get('a1')).toMatchObject({
      generation: 2,
      state: 'closed',
    })
    expect(again.entries.some((e) => e.kind === 'witness' && e.lastState === 'closed')).toBe(true)
  } finally {
    tmp.cleanup()
  }
})

test('a suspended attempt keeps its reservation; while the step waits again its own estimate is not counted twice', async () => {
  h = await workerHarness({ lead: { script: oneStep() } })
  h.addAgent()
  h.fake.hooks.afterStart = () => {
    h.fake.hooks.afterStart = undefined
    h.db.sqlite.prepare("UPDATE orc_attempts SET agent_incarnation = 'older'").run()
  }
  const id = await h.create({ budgetUsd: 1 })
  await h.until(() => attempt()['suspended'] === 1, 40_000)
  const view = () => h.db.read((sqlite) => budgetView(sqlite, readOrch(sqlite, id)!))
  // After a re-approval the step waits again (`queued`) with its suspended attempt still holding the $0.50.
  h.db.sqlite.prepare("UPDATE orc_steps SET status = 'queued'").run()
  const once = view().reservedUsd
  h.db.sqlite.prepare("UPDATE orc_attempts SET suspended = 0 WHERE kind = 'step'").run()
  const twice = view().reservedUsd
  expect(twice - once).toBeCloseTo(0.5, 6)
  expect(attempt()['reserved_usd']).toBe(0.5)
})

test('the supervisor’s expiry is the orchestration’s deadline, not release + the per-turn cap', async () => {
  const deadline = Date.now() + 5 * 60_000
  h = await workerHarness({ lead: { script: oneStep() }, maxTurnMs: 30 * 60_000 })
  h.addAgent()
  const id = await h.create({ deadlineAt: new Date(deadline).toISOString() })
  await h.until(() => h.orch.summary(id).status === 'succeeded', 40_000)
  const launch = h.rows<{ deadline_at: number }>('SELECT deadline_at FROM coding_launches')[0]!
  expect(launch.deadline_at).toBe(deadline)
})
