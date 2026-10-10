import { afterEach, expect, test } from 'vitest'
import { HttpError } from '../../src/errors.ts'
import { GlobalFenceStore } from '../../src/domain/orchestration/fence.ts'
import { ExecutionJournal, journalDispatches } from '../../src/domain/orchestration/journal.ts'
import { notDispatched } from '../../src/hermes/port.ts'
import { byTurn } from '../../src/hermes/fake/fake-lead.ts'
import { tempDir } from '../orchestration/harness-db.ts'
import { attemptOf } from '../orchestration/harness.ts'
import {
  agent,
  definition,
  edge,
  end,
  node,
  run,
  start,
  wfHarness,
  type Harness,
} from './wf-harness.ts'

let h: Harness | undefined
afterEach(async () => {
  await h?.close()
  h = undefined
})
const done =
  (id: string, status = 'succeeded') =>
  (): boolean =>
    run(h!, id).status === status

/** Hermes refuses every dispatch while `refusing` is true (nothing is sent: a proven refusal). */
function outage(harness: Harness) {
  const state = { refusing: true, calls: 0 }
  const original = harness.port.startRun.bind(harness.port)
  harness.port.startRun = async (req) => {
    state.calls++
    if (state.refusing)
      throw notDispatched(new HttpError(503, 'hermes_unavailable', 'Live adapter is not started'))
    return original(req)
  }
  return state
}
const attemptRow = (harness: Harness) =>
  harness.rows<{
    id: string
    state: string
    dispatch_generation: number
    refused_total: number
    refused_streak: number
    next_try_at: string | null
    needs_person: number
  }>('SELECT * FROM orc_attempts ORDER BY created_at, rowid')
const journalFor = (harness: Harness, attemptId: string) => {
  const read = harness.journal.readOwn()
  if (!read.ok) throw new Error(read.reason)
  return read.entries.filter((e) => 'attemptId' in e && e.attemptId === attemptId)
}

test('an outage is waited out with one attempt: every refused generation is journaled, then it is sent', async () => {
  h = await wfHarness()
  const out = outage(h)
  const id = await start(h, definition([agent('a'), end()], [edge('a', 'done')]))
  await h.until(() => out.calls >= 3)
  const [attempt] = attemptRow(h)
  expect(attemptRow(h)).toHaveLength(1)
  expect(attempt!.state).toBe('created')
  expect(node(h, id, 'a').attemptsUsed).toBe(1)
  // The refusals did not consume logical attempts or create attempt rows.
  out.refusing = false
  await h.until(done(id))
  expect(attemptRow(h)).toHaveLength(1)
  const kinds = journalFor(h, attemptRow(h)[0]!.id).map((e) => `${e.kind}`)
  expect(kinds.filter((k) => k === 'send_refused').length).toBeGreaterThanOrEqual(2)
  expect(kinds.filter((k) => k.startsWith('send_')).at(-1)).toBe('send_started')
  const read = h.journal.readOwn()
  if (!read.ok) throw new Error(read.reason)
  expect(journalDispatches(read.entries).get(attemptRow(h)[0]!.id)).toMatchObject({
    state: 'sent',
    generation: attemptRow(h)[0]!.dispatch_generation,
  })
})

test('after five refusals in a row the node waits "Hermes unavailable" for ten minutes or a readiness change', async () => {
  h = await wfHarness()
  const out = outage(h)
  const id = await start(h, definition([agent('a'), end()], [edge('a', 'done')]))
  await h.until(() => attemptRow(h!)[0]?.refused_streak === 5, 600_000)
  const calls = out.calls
  expect(attemptRow(h)[0]!.next_try_at).not.toBeNull()
  expect(node(h, id, 'a').waitingFor).toBe('hermes_unavailable')
  await h.settle(60_000)
  expect(out.calls).toBe(calls)
  // A readiness change (version check, gateway reachable again) retries at once.
  out.refusing = false
  await h.orch.agentReady('builder')
  await h.until(done(id))
  expect(attemptRow(h)[0]!.refused_streak).toBe(0)
})

test('the ten-minute timer retries without any readiness change', async () => {
  h = await wfHarness()
  const out = outage(h)
  const id = await start(h, definition([agent('a'), end()], [edge('a', 'done')]))
  await h.until(() => attemptRow(h!)[0]?.refused_streak === 5, 600_000)
  out.refusing = false
  await h.settle(11 * 60_000)
  await h.until(done(id))
})

test('twenty refused generations need the person: Try again continues, Stop ends', async () => {
  h = await wfHarness()
  const out = outage(h)
  const id = await start(h, definition([agent('a'), end()], [edge('a', 'done')]))
  for (let i = 0; i < 40 && attemptRow(h)[0]?.needs_person !== 1; i++) {
    await h
      .until(() => (attemptRow(h!)[0]?.refused_streak ?? 0) > 0, 600_000)
      .catch(() => undefined)
    await h.orch.agentReady('builder')
    await h.settle(2000)
  }
  expect(attemptRow(h)[0]!.needs_person).toBe(1)
  expect(attemptRow(h)[0]!.refused_total).toBe(20)
  expect(node(h, id, 'a').waitingFor).toBe('refusal_limit')
  expect(run(h, id).needsYou.find((n) => n.kind === 'refusal_limit')).toMatchObject({
    nodeId: 'a',
    refusals: 20,
  })
  // Automatic readiness changes do not clear it.
  const before = out.calls
  await h.orch.agentReady('builder')
  await h.settle(5000)
  expect(out.calls).toBe(before)
  out.refusing = false
  await h.orch.wfTryAgain(id, 'a', {
    expectedNodeRevision: node(h, id, 'a').revision,
    orchestrationRevision: run(h, id).revision,
  })
  await h.until(done(id))
})

test('in an orchestration the step fails at the lifetime limit and the lead decides', async () => {
  h = await wfHarness()
  // A scripted lead on the same executor: assign one step, then finish whatever happens.
  const { attachFakeLead } = await import('../../src/hermes/fake/fake-lead.ts')
  attachFakeLead(h.port, h.orch, {
    script: byTurn({
      1: async (t) => {
        await t.call('orch.assign', { agent: 'builder', instruction: 'work' })
      },
      2: async (t) => {
        await t.call('orch.finish', { outcome: 'partial', summary: 'builder unreachable' })
      },
    }),
  })
  const original = h.port.startRun.bind(h.port)
  h.port.startRun = async (req) => {
    if (req.agentId === 'builder')
      throw notDispatched(new HttpError(503, 'hermes_unavailable', 'Live adapter is not started'))
    return original(req)
  }
  const id = await h.create({ gatePolicy: 'none' })
  for (
    let i = 0;
    i < 80 && h.orch.snapshot(id).orchestration.stepsList[0]?.status !== 'failed';
    i++
  ) {
    await h.settle(2000)
    await h.orch.agentReady('builder')
  }
  const step = h.orch.snapshot(id).orchestration.stepsList[0]!
  expect(step.status).toBe('failed')
  expect(step.disposition).toBe('hermes_refused')
  expect(attemptOf(h, id, 'step', 's1')[0]!.state).toBe('refused')
  await h.until(() => h!.orch.summary(id).status === 'succeeded', 240_000)
})

test('a refusal that cannot be journaled keeps the attempt sent/unknown: nothing is claimed unsent', async () => {
  h = await wfHarness()
  const out = outage(h)
  const append = h.journal.append.bind(h.journal)
  h.journal.append = (entry) => {
    if (entry.kind === 'send_refused') throw new Error('disk full')
    return append(entry)
  }
  const id = await start(h, definition([agent('a'), end()], [edge('a', 'done')]))
  await h.until(() => attemptRow(h!)[0]?.state === 'unknown')
  expect(attemptRow(h)[0]!.state).toBe('unknown')
  expect(out.calls).toBe(1)
  expect(run(h, id).status).toBe('running')
  expect(node(h, id, 'a').state).toBe('running')
})

// ------------------------------------------------------------------------------------- bounded journal witness

test('100 refusals with compaction in between keep the journal bounded and the latest generation visible', () => {
  const tmp = tempDir('journal-')
  try {
    const journal = new ExecutionJournal(tmp.dir, 'scope')
    for (let g = 1; g <= 100; g++) {
      journal.append({
        kind: 'send_started',
        attemptId: 'att',
        orchestrationId: 'o',
        attemptKind: 'step',
        agentId: 'builder',
        generation: g,
      })
      journal.append({
        kind: 'send_refused',
        attemptId: 'att',
        orchestrationId: 'o',
        generation: g,
      })
      if (g % 10 === 0) journal.compact(() => false)
    }
    const read = journal.readOwn()
    if (!read.ok) throw new Error(read.reason)
    const mine = read.entries.filter((e) => 'attemptId' in e && e.attemptId === 'att')
    expect(mine.length).toBeLessThanOrEqual(3)
    expect(journalDispatches(read.entries).get('att')).toMatchObject({
      generation: 100,
      state: 'refused',
    })
    const last = read.entries.at(-1)!
    expect(last.n).toBeGreaterThanOrEqual(200)
    // Numbering never goes back, even though most entries are gone.
    journal.append({
      kind: 'send_started',
      attemptId: 'att',
      orchestrationId: 'o',
      attemptKind: 'step',
      agentId: 'builder',
      generation: 101,
    })
    const after = journal.readOwn()
    if (!after.ok) throw new Error(after.reason)
    expect(after.entries.at(-1)!.n).toBeGreaterThan(last.n)
    journal.compact(() => false)
    const again = journal.readOwn()
    if (!again.ok) throw new Error(again.reason)
    expect(journalDispatches(again.entries).get('att')).toMatchObject({
      generation: 101,
      state: 'sent',
    })
    expect(again.entries.filter((e) => 'attemptId' in e && e.attemptId === 'att')).toHaveLength(1)
  } finally {
    tmp.cleanup()
  }
})

/** A database that is behind the journal on one attempt's dispatch generation. */
async function restoredAt(
  generation: number,
): Promise<{ fenced: boolean; store: GlobalFenceStore }> {
  if (!h) throw new Error('no harness')
  const sqlite = h.db.sqlite
  sqlite.prepare('UPDATE orc_attempts SET dispatch_generation = ?').run(generation)
  const store = new GlobalFenceStore(h!.db, h!.journal, () => h!.scheduler.now())
  return { fenced: store.startupCheck().fenced, store }
}

test('restore after compaction across a refused generation: a database behind the witness is a doubt', async () => {
  h = await wfHarness()
  const out = outage(h)
  await start(h, definition([agent('a'), end()], [edge('a', 'done')]))
  await h.until(() => (attemptRow(h!)[0]?.dispatch_generation ?? 0) >= 3)
  out.refusing = false
  out.calls = -100000
  // Hold the outage: stop sending again so the latest journaled word is a refusal.
  out.refusing = true
  await h.settle(3000)
  const generation = attemptRow(h)[0]!.dispatch_generation
  h.journal.compact(() => false)
  const witness = h.journal.readOwn()
  if (!witness.ok) throw new Error(witness.reason)
  expect(witness.entries.filter((e) => e.kind === 'witness').length).toBe(1)
  expect((await restoredAt(generation)).fenced).toBe(false)
  expect((await restoredAt(generation - 1)).fenced).toBe(true)
})

test('restore across a later accepted generation: a database behind the sent generation is a doubt', async () => {
  h = await wfHarness()
  const out = outage(h)
  const id = await start(
    h,
    definition([agent('a', { instruction: '[fake:hold] A' }), end()], [edge('a', 'done')]),
  )
  await h.until(() => (attemptRow(h!)[0]?.dispatch_generation ?? 0) >= 2)
  out.refusing = false
  await h.until(
    () => run(h!, id).attempts[0]?.runId !== null && run(h!, id).attempts[0]?.runId !== undefined,
  )
  const generation = attemptRow(h)[0]!.dispatch_generation
  h.journal.compact(() => false)
  expect((await restoredAt(generation)).fenced).toBe(false)
  expect((await restoredAt(generation - 1)).fenced).toBe(true)
})

test('a journal that says the latest generation was sent keeps the attempt from ever being sent again', async () => {
  h = await wfHarness()
  const out = outage(h)
  await start(h, definition([agent('a'), end()], [edge('a', 'done')]))
  await h.until(() => (attemptRow(h!)[0]?.dispatch_generation ?? 0) >= 2)
  const attempt = attemptRow(h)[0]!
  // The database lost the refusal and shows `created`, but the journal's newest word is a sent generation.
  h.journal.append({
    kind: 'send_started',
    attemptId: attempt.id,
    orchestrationId: 'x',
    attemptKind: 'step',
    agentId: 'builder',
    generation: attempt.dispatch_generation + 1,
  })
  out.refusing = false
  await h.settle(5000)
  expect(attemptRow(h)[0]!.state).toBe('unknown')
  expect(attemptRow(h)[0]!.state).not.toBe('running')
})

test('an agent that becomes served again ends the refusal wait without any person or timer', async () => {
  h = await wfHarness()
  const out = outage(h)
  const served = { value: false }
  const list = h.port.listAgents.bind(h.port)
  h.port.listAgents = async () => (await list()).map((a) => ({ ...a, served: served.value }))
  const id = await start(h, definition([agent('a'), end()], [edge('a', 'done')]))
  await h.until(() => attemptRow(h!)[0]?.refused_streak === 5, 600_000)
  await h.settle(30_000)
  expect(attemptRow(h)[0]!.next_try_at).not.toBeNull()
  out.refusing = false
  served.value = true
  await h.settle(15_000)
  await h.until(done(id))
})

// Codex review: a refusal lost within the same generation
test('a refusal journaled for generation g but lost by the database (still send_started at g) is detected and reconciled', async () => {
  h = await wfHarness()
  outage(h)
  await start(h, definition([agent('a'), end()], [edge('a', 'done')]))
  await h.until(() => (attemptRow(h!)[0]?.refused_total ?? 0) >= 2)
  await h.orch.close()
  const row = attemptRow(h)[0]!
  // The crash: the journal has send_refused(g); the transaction that records it never committed.
  h.db.sqlite
    .prepare(
      "UPDATE orc_attempts SET state = 'send_started', refused_total = ?, refused_streak = ?, refused_generation = ? WHERE id = ?",
    )
    .run(row.refused_total - 1, row.refused_streak - 1, row.dispatch_generation - 1, row.id)
  const store = new GlobalFenceStore(h.db, h.journal, () => h!.scheduler.now())
  expect(store.startupCheck()).toMatchObject({ fenced: true, reasons: ['journal_mismatch'] })
  const after = attemptRow(h)[0]! as typeof row & { refused_generation: number }
  expect(after.state).toBe('created')
  expect(after.refused_total).toBe(row.refused_total)
  expect(after.refused_streak).toBe(row.refused_streak)
  expect(after.refused_generation).toBe(row.dispatch_generation)
})

// round 2 (M): recovery of a lost refusal follows the normal policy
type Planner = 'workflow' | 'lead'
async function lostRefusal(planner: Planner, previousTotal: number, previousStreak: number) {
  h = await wfHarness()
  const { HttpError: E } = await import('../../src/errors.ts')
  const original = h.port.startRun.bind(h.port)
  h.port.startRun = async (req) => {
    if (req.agentId === 'builder') throw notDispatched(new E(503, 'hermes_unavailable', 'down'))
    return original(req)
  }
  if (planner === 'workflow') await start(h, definition([agent('a'), end()], [edge('a', 'done')]))
  else {
    const { attachFakeLead } = await import('../../src/hermes/fake/fake-lead.ts')
    attachFakeLead(h.port, h.orch, {
      script: byTurn({ 1: async (t) => void (await t.call('orch.assign', { agent: 'builder', instruction: 'work' })) }),
    })
    await h.create({ gatePolicy: 'none' })
  }
  const stepAttempts = () =>
    h!.rows<ReturnType<typeof attemptRow>[number]>("SELECT * FROM orc_attempts WHERE kind = 'step'")
  await h.until(() => (stepAttempts()[0]?.refused_total ?? 0) >= 1 && stepAttempts()[0]!.state === 'created')
  await h.orch.close()
  const row = stepAttempts()[0]!
  // The crash: send_refused(g) is journaled, but the database still reads send_started at g.
  h.db.sqlite
    .prepare("UPDATE orc_attempts SET state = 'send_started', refused_total = ?, refused_streak = ?, refused_generation = ?, needs_person = 0, next_try_at = NULL WHERE id = ?")
    .run(previousTotal, previousStreak, row.dispatch_generation - 1, row.id)
  const store = new GlobalFenceStore(h.db, h.journal, () => h!.scheduler.now())
  expect(store.startupCheck().fenced).toBe(true)
  const after = h.rows<Record<string, unknown>>('SELECT * FROM orc_attempts WHERE id = ?', row.id)[0]!
  const step = h.rows<{ status: string; disposition: string | null }>('SELECT status, disposition FROM orc_steps')[0]!
  return { after, step }
}

test.each<[Planner, string]>([['workflow', 'workflow'], ['lead', 'orchestration']])(
  'a lost fifth refusal (%s) sets the ten-minute wait, not an immediate resend',
  async (planner) => {
    const { after } = await lostRefusal(planner, 3, 4)
    expect(after['state']).toBe('created')
    expect(after['refused_streak']).toBe(5)
    expect(after['next_try_at']).not.toBeNull()
    expect(after['needs_person']).toBe(0)
  },
)

test('a lost twentieth refusal needs the person in a workflow', async () => {
  const { after } = await lostRefusal('workflow', 19, 3)
  expect(after['state']).toBe('created')
  expect(after['needs_person']).toBe(1)
  expect(after['refused_total']).toBe(20)
})

test('a lost twentieth refusal in an orchestration fails the step for the lead', async () => {
  const { after, step } = await lostRefusal('lead', 19, 3)
  expect(after['state']).toBe('refused')
  expect(after['needs_person']).toBe(0)
  expect(step).toEqual({ status: 'failed', disposition: 'hermes_refused' })
})
