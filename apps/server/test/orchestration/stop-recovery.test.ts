import { afterEach, expect, test, vi } from 'vitest'
import { Orchestrator } from '../../src/domain/orchestration/executor.ts'
import { byTurn } from '../../src/hermes/fake/fake-lead.ts'
import { attemptOf, endRun, harness, type Harness } from './harness.ts'

let h: Harness
const releases: (() => void)[] = []
afterEach(async () => {
  for (const release of releases.splice(0)) release()
  await h?.close()
})
const status = (id: string) => h.orch.summary(id).status
const detail = (id: string) => h.orch.snapshot(id).orchestration

/** Holds `port.startRun` (the Hermes POST) until released; counts the calls. */
function holdStartRun() {
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  releases.push(release)
  const original = h.port.startRun.bind(h.port)
  const state = { calls: 0 }
  h.port.startRun = async (req) => {
    state.calls++
    await gate
    return original(req)
  }
  return { release, state }
}

test('Stop during admission: nothing new is admitted, and the late run handle is stopped as soon as it arrives', async () => {
  h = await harness()
  const hold = holdStartRun()
  const id = await h.create()
  await h.until(() => attemptOf(h, id, 'lead').some((a) => a.state === 'send_started'))
  // The POST is in flight. Stop now.
  await h.orch.stop(id)
  expect(status(id)).toBe('stopping')
  expect(
    h.rows("SELECT 1 FROM orc_attempts WHERE retired = 1 AND state = 'send_started'"),
  ).toHaveLength(1)
  // Hermes admits the run after the Stop (late admission): the executor stops it at once.
  hold.release()
  await h.until(() => attemptOf(h, id, 'lead')[0]!.stopAcknowledgedAt !== null)
  // A cancelled run is not termination evidence: the attempt is not confirmed ended, and the run keeps saying so.
  await h.settle()
  expect(attemptOf(h, id, 'lead')[0]!.state).toBe('unknown')
  expect(status(id)).toBe('stopping')
  expect(detail(id).unconfirmed).toEqual([attemptOf(h, id, 'lead')[0]!.id])
  expect(detail(id).ownership).toBe('owned')
  // No further admission happened.
  expect(attemptOf(h, id, 'lead')).toHaveLength(1)
  expect(hold.state.calls).toBe(1)
  // The Stop fence was journaled before the commit.
  const journal = h.journal.readOwn()
  expect(journal.ok && journal.entries.map((e) => e.kind)).toEqual([
    'send_started',
    'stop_fence',
    'run_handle',
  ])
  // The person abandons the unconfirmed attempt: the run is stopped, the owed Stop is kept until acknowledged.
  const lead = attemptOf(h, id, 'lead')[0]!
  await h.orch.abandon(id, {
    attemptIds: [lead.id],
    orchestrationRevision: detail(id).revision,
    acknowledge: true,
  })
  await h.settle()
  expect(status(id)).toBe('stopped')
  expect(detail(id).attempts[0]!.state).toBe('abandoned')
})

test('Stop retires queued work with a disposition and withdraws gates and inquiries', async () => {
  h = await harness({
    lead: {
      script: byTurn({
        1: async (t) => {
          await t.call('orch.assign', { agent: 'builder', instruction: 'first' })
          await t.call('orch.assign', { agent: 'reviewer', instruction: 'second', after: ['s1'] })
          await t.call('orch.ask', { question: 'Which?' })
        },
      }),
    },
  })
  const id = await h.create({ gatePolicy: 'every-step' })
  await h.until(() => detail(id).gates.length === 2 && detail(id).inquiries.length === 1)
  await h.orch.stop(id)
  await h.settle()
  const d = detail(id)
  expect(d.stepsList.map((s) => [s.status, s.disposition])).toEqual([
    ['not_started', 'not_started: stopped'],
    ['not_started', 'not_started: stopped'],
  ])
  expect(d.gates.every((g) => g.status === 'withdrawn')).toBe(true)
  expect(d.inquiries[0]!.status).toBe('withdrawn')
  // The lead attempt that was running ends unconfirmed (its run was cancelled), so the run is still stopping.
  expect(['stopping', 'stopped']).toContain(d.status)
  // Stop is idempotent and Resume cannot revive it.
  await h.orch.stop(id)
  await expect(
    h.orch.resume(id, { orchestrationRevision: detail(id).revision }),
  ).rejects.toMatchObject({ status: 409 })
})

test('an interrupted step is unknown: it fences the run (no steps, no new lead turn) until the person abandons it', async () => {
  h = await harness({
    lead: {
      script: byTurn({
        1: async (t) => {
          await t.call('orch.assign', { agent: 'builder', instruction: '[fake:hold]' })
          await t.call('orch.assign', { agent: 'reviewer', instruction: 'second, independent' })
        },
        2: async (t) => {
          await t.call('orch.finish', { outcome: 'partial', summary: 'moved on' })
        },
      }),
    },
  })
  const id = await h.create({ gatePolicy: 'none', maxConcurrentSteps: 1 })
  await h.until(() => attemptOf(h, id, 'step', 's1').some((a) => a.state === 'running'))
  const run = attemptOf(h, id, 'step', 's1')[0]!.runId!
  await endRun(h, run, 'interrupted')
  await h.until(() => detail(id).stepsList[0]!.status === 'unknown')
  expect(h.orch.summary(id).needsYou).toContainEqual({
    kind: 'unknown',
    attemptId: attemptOf(h, id, 'step', 's1')[0]!.id,
  })
  // Nothing is admitted while the fence stands: not the queued second step, not a new lead turn that could add more.
  await h.settle(5000)
  expect(detail(id).stepsList[1]!.status).toBe('queued')
  expect(attemptOf(h, id, 'step', 's2')).toHaveLength(0)
  expect(attemptOf(h, id, 'lead')).toHaveLength(1)
  expect(status(id)).toBe('running')
  // A person's Resume cannot lift the fence either (the run is not even paused); abandoning is the explicit decision.
  const s1 = attemptOf(h, id, 'step', 's1')[0]!
  await h.orch.abandon(id, {
    attemptIds: [s1.id],
    orchestrationRevision: detail(id).revision,
    acknowledge: true,
  })
  expect(status(id)).toBe('paused')
  expect(h.orch.summary(id).pauseReason).toBe('abandonment')
  expect(detail(id).stepsList[0]!.status).toBe('failed')
  expect(detail(id).stepsList[0]!.disposition).toContain('stopped waiting')
  await h.settle(2000)
  expect(attemptOf(h, id, 'step', 's2')).toHaveLength(0)
  await h.orch.resume(id, { orchestrationRevision: detail(id).revision })
  await h.until(() => ['succeeded', 'finished_with_unresolved'].includes(status(id)))
  expect(attemptOf(h, id, 'step', 's2')).toHaveLength(1)
  // The abandoned attempt keeps its owed Stop and is reported as not confirmed ended, so the run says so.
  expect(status(id)).toBe('finished_with_unresolved')
  expect(detail(id).attempts.find((a) => a.id === s1.id)!.state).toBe('abandoned')
  expect(detail(id).stepsList[0]!.status).toBe('failed')
})

test('late evidence for an abandoned attempt is recorded, never consumed', async () => {
  h = await harness({
    lead: {
      script: byTurn({
        1: async (t) => {
          await t.call('orch.assign', { agent: 'builder', instruction: '[fake:hold]' })
        },
      }),
    },
  })
  const id = await h.create({ gatePolicy: 'none' })
  await h.until(() => attemptOf(h, id, 'step', 's1').some((a) => a.state === 'running'))
  const s1 = attemptOf(h, id, 'step', 's1')[0]!
  await endRun(h, s1.runId!, 'cancelled')
  await h.until(() => detail(id).stepsList[0]!.status === 'unknown')
  await h.orch.abandon(id, {
    attemptIds: [s1.id],
    orchestrationRevision: detail(id).revision,
    acknowledge: true,
  })
  await h.until(() => attemptOf(h, id, 'step', 's1')[0]!.stopAcknowledgedAt !== null)
  const before = JSON.stringify(detail(id).stepsList)
  // A cancelled run cannot produce evidence later (Hermes does not revive it), but a record of a late result for an
  // abandoned attempt is kept when one arrives: simulate by flipping the run row as a late `completed` would.
  h.db.sqlite
    .prepare("UPDATE runs SET status = 'completed', output = 'late text' WHERE id = ?")
    .run(s1.runId!)
  await h.settle(1000)
  expect(h.rows("SELECT detail FROM orc_history WHERE kind = 'late_result'")).toHaveLength(1)
  expect(JSON.stringify(detail(id).stepsList)).toBe(before)
  expect(detail(id).attempts.find((a) => a.id === s1.id)!.evidence).toBe('completed')
  expect(detail(id).attempts.find((a) => a.id === s1.id)!.state).toBe('abandoned')
})

test('X4: an `unconfirmed` Stop outcome is not acknowledged; a later `stopped` one is', async () => {
  h = await harness({
    lead: {
      script: byTurn({
        1: async (t) => {
          await t.call('orch.assign', { agent: 'builder', instruction: '[fake:hold]' })
        },
      }),
    },
  })
  let outcome: 'unconfirmed' | 'stopped' = 'unconfirmed'
  const asked: string[] = []
  const original = h.port.stopRun.bind(h.port)
  // The fake port stops for real but answers like a coding runtime that has not yet proven the end.
  h.port.stopRun = (async (req: { agentId: string; runId: string }) => {
    asked.push(req.runId)
    await original(req)
    return outcome
  }) as unknown as typeof h.port.stopRun
  const id = await h.create({ gatePolicy: 'none' })
  await h.until(() => attemptOf(h, id, 'step', 's1').some((a) => a.state === 'running'))
  const s1 = attemptOf(h, id, 'step', 's1')[0]!
  await endRun(h, s1.runId!, 'cancelled')
  await h.until(() => detail(id).stepsList[0]!.status === 'unknown')
  await h.orch.abandon(id, {
    attemptIds: [s1.id],
    orchestrationRevision: detail(id).revision,
    acknowledge: true,
  })
  await h.until(() => asked.length > 0)
  await h.settle(3000)
  expect(asked.length).toBeGreaterThan(0)
  expect(attemptOf(h, id, 'step', 's1')[0]!.stopAcknowledgedAt).toBeNull()
  outcome = 'stopped'
  await h.until(() => attemptOf(h, id, 'step', 's1')[0]!.stopAcknowledgedAt !== null)
})

test('restart: an admission that was started but whose handle was never recorded becomes unknown and is never replayed', async () => {
  h = await harness()
  const hold = holdStartRun()
  const id = await h.create()
  await h.until(() => attemptOf(h, id, 'lead').some((a) => a.state === 'send_started'))
  // "Crash": a fresh executor starts on the same database and the same port while the POST never returned.
  const restarted = new Orchestrator({
    db: h.db,
    ingest: h.ingest,
    port: h.port,
    access: h.access,
    fence: h.fence,
    clock: () => h.scheduler.now(),
    retryMs: 1000,
  })
  await restarted.recover()
  await restarted.pump()
  expect(attemptOf(h, id, 'lead')).toHaveLength(1)
  expect(attemptOf(h, id, 'lead')[0]!.state).toBe('unknown')
  expect(attemptOf(h, id, 'lead')[0]!.unknownReason).toBe('crash_after_send_started')
  // The only POST ever made is the original one: recovery did not resend.
  expect(hold.state.calls).toBe(1)
  expect(h.orch.summary(id).needsYou).toContainEqual({
    kind: 'unknown',
    attemptId: attemptOf(h, id, 'lead')[0]!.id,
  })
  hold.release()
  await restarted.close()
})

test('a journal that cannot be written fences admission and nothing is sent; lifting the fence re-dispatches with a fresh capability', async () => {
  h = await harness()
  const send = vi.spyOn(h.port, 'startRun')
  const append = vi.spyOn(h.journal, 'append').mockImplementationOnce(() => {
    throw new Error('disk full')
  })
  const id = await h.create()
  await h.until(() => h.fence.view().fenced)
  expect(append).toHaveBeenCalled()
  expect(h.fence.view().reason).toBe('journal_unwritable')
  expect(send).not.toHaveBeenCalled()
  // The claim was committed (attempt `created`), the send was rolled back.
  expect(attemptOf(h, id, 'lead').map((a) => a.state)).toEqual(['created'])
  expect(h.rows('SELECT 1 FROM orc_capabilities')).toHaveLength(0)
  // Fenced: still nothing, however often the executor runs.
  await h.settle(5000)
  expect(send).not.toHaveBeenCalled()
  h.fence.lift(h.fence.view().revision, 'checked the disk')
  await h.orch.pump()
  await h.until(() => status(id) === 'succeeded')
  expect(send).toHaveBeenCalled()
  expect(
    h.rows<{ generation: number }>('SELECT generation FROM orc_capabilities ORDER BY created_at')
      .length,
  ).toBeGreaterThanOrEqual(1)
})

test('two executors on one database never run two lead attempts at once (wake-up claim)', async () => {
  h = await harness()
  const hold = holdStartRun()
  const second = new Orchestrator({
    db: h.db,
    ingest: h.ingest,
    port: h.port,
    access: h.access,
    fence: h.fence,
    clock: () => h.scheduler.now(),
    retryMs: 1000,
  })
  const id = await h.create()
  h.orch.kick()
  second.kick()
  await h.settle(1000)
  expect(attemptOf(h, id, 'lead')).toHaveLength(1)
  expect(hold.state.calls).toBe(1)
  hold.release()
  await second.close()
})

test('a definite Hermes refusal fails the step with a recorded disposition and wakes the lead', async () => {
  h = await harness({
    lead: {
      script: byTurn({
        1: async (t) => {
          await t.call('orch.assign', { agent: 'builder', instruction: 'work' })
        },
        2: async (t) => {
          await t.call('orch.finish', { outcome: 'failed', summary: 'refused' })
        },
      }),
    },
  })
  const original = h.port.startRun.bind(h.port)
  const { HttpError } = await import('../../src/errors.ts')
  h.port.startRun = async (req) => {
    if (req.agentId === 'builder')
      throw new HttpError(422, 'admission_refused', 'Hermes refused this run')
    return original(req)
  }
  const id = await h.create({ gatePolicy: 'none' })
  await h.until(() => ['failed', 'finished_with_unresolved', 'succeeded'].includes(status(id)))
  const d = detail(id)
  expect(d.stepsList[0]!.status).toBe('failed')
  expect(d.stepsList[0]!.disposition).toBe('admission_refused')
  expect(d.attempts.find((a) => a.stepId === 's1')!.state).toBe('refused')
  expect(status(id)).toBe('failed')
})

test('an uncertain Hermes error makes the attempt unknown (never retried)', async () => {
  h = await harness({
    lead: {
      script: byTurn({
        1: async (t) => {
          await t.call('orch.assign', { agent: 'builder', instruction: 'work' })
        },
      }),
    },
  })
  const original = h.port.startRun.bind(h.port)
  let builderCalls = 0
  h.port.startRun = async (req) => {
    if (req.agentId === 'builder') {
      builderCalls++
      throw new Error('socket hang up')
    }
    return original(req)
  }
  const id = await h.create({ gatePolicy: 'none' })
  await h.until(() => detail(id).stepsList[0]?.status === 'unknown')
  await h.settle(5000)
  expect(builderCalls).toBe(1)
  expect(attemptOf(h, id, 'step', 's1')[0]!.unknownReason).toBe('admission_uncertain')
})

test('a refusal raised before anything was sent is retried later, not turned into unknown', async () => {
  h = await harness()
  const { notDispatched } = await import('../../src/hermes/port.ts')
  const { HttpError } = await import('../../src/errors.ts')
  const original = h.port.startRun.bind(h.port)
  let calls = 0
  h.port.startRun = async (req) => {
    calls++
    if (calls === 1)
      throw notDispatched(new HttpError(503, 'hermes_unavailable', 'Live adapter is not started'))
    return original(req)
  }
  const id = await h.create()
  await h.until(() => calls === 1)
  await h.settle(100)
  expect(attemptOf(h, id, 'lead')[0]!.state).toBe('refused')
  // The turn is claimed again after the pause, with its causes back.
  await h.until(() => status(id) === 'succeeded', 240_000)
  expect(calls).toBeGreaterThan(1)
  expect(detail(id).leadTurnsUsed).toBeLessThanOrEqual(4)
})
