import { afterEach, expect, test } from 'vitest'
import { byTurn } from '../../src/hermes/fake/fake-lead.ts'
import { runRecoveredObservation } from '../../src/hermes/live/translate.ts'
import { attemptOf, harness, type Harness } from './harness.ts'

let h: Harness
afterEach(async () => {
  await h?.close()
  h = undefined as never
})
const status = (id: string) => h.orch.summary(id).status
const detail = (id: string) => h.orch.snapshot(id).orchestration

test('fix-i 1: a sibling that turns unknown while an earlier dispatch awaits its reply stops the next send', async () => {
  h = await harness({
    lead: {
      script: byTurn({
        1: async (t) => {
          await t.call('orch.assign', { agent: 'builder', instruction: '[fake:hold] first' })
          await t.call('orch.assign', { agent: 'reviewer', instruction: 'GATE second' })
          await t.call('orch.assign', { agent: 'builder', instruction: 'third' })
        },
      }),
    },
  })
  // The second dispatch waits for its reply; meanwhile the first run is reported as recovered text only.
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  const start = h.port.startRun.bind(h.port)
  h.port.startRun = async (req) => {
    if (req.input.includes('GATE second')) await gate
    return start(req)
  }
  const id = await h.create({ gatePolicy: 'none', maxConcurrentSteps: 3 })
  await h.until(() => attemptOf(h, id, 'step', 's1').some((a) => a.state === 'running'))
  await h.until(() => attemptOf(h, id, 'step', 's3').length === 1)
  const first = attemptOf(h, id, 'step', 's1')[0]!
  await h.ingest.submit(
    runRecoveredObservation(
      { profile: 'builder', runId: first.runId!, credentialGeneration: 1 },
      'Recovered answer text',
    ),
  )
  release()
  await h.settle(5000)
  expect(attemptOf(h, id, 'step', 's1')[0]!.state).toBe('unknown')
  expect(attemptOf(h, id, 'step', 's3')[0]!.state).toBe('created')
  expect(attemptOf(h, id, 'step', 's3')[0]!.runId).toBeNull()
  expect(status(id)).not.toBe('succeeded')
})

// ------------------------------------------------------------------ item 3: remap keeps a manual Pause

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'

test('fix-i 3: replacement pause -> manual Pause -> remap leaves the run paused with no new lead attempt; Resume restores', async () => {
  h = await harness({
    lead: {
      script: byTurn({
        1: async (t) => {
          await t.call('orch.ask', { question: 'ready?' })
        },
      }),
    },
  })
  h.db.sqlite
    .prepare(
      "INSERT INTO agent_lifecycle (agent_id, incarnation_id, state) VALUES ('lead', ?, 'ready')",
    )
    .run(A)
  const id = await h.create()
  await h.until(() => detail(id).inquiries.length === 1)
  await h.until(() => attemptOf(h, id, 'lead')[0]!.state === 'terminated')
  h.db.sqlite
    .prepare("UPDATE agent_lifecycle SET incarnation_id = ? WHERE agent_id = 'lead'")
    .run(B)
  await h.orch.inquiryAnswer(id, 'q1', {
    answer: 'yes',
    expectedRevision: 1,
    orchestrationRevision: detail(id).revision,
  })
  await h.until(() => status(id) === 'paused')
  expect(h.orch.summary(id).pauseReason).toBe('agent_unavailable')
  await h.orch.pause(id, { orchestrationRevision: detail(id).revision })
  await h.orch.remap(id, {
    agentId: 'lead',
    frozenIncarnation: A,
    currentIncarnation: B,
    orchestrationRevision: detail(id).revision,
    acknowledge: true,
  })
  await h.settle(5000)
  expect(status(id)).toBe('paused')
  expect(h.orch.summary(id).pauseReason).not.toBe('agent_unavailable')
  expect(h.rows('SELECT manual_paused_at FROM orchestrations WHERE id = ?', id)[0]).not.toEqual({
    manual_paused_at: null,
  })
  expect(attemptOf(h, id, 'lead')).toHaveLength(1)
  // Restore: Resume ends the hold and the lead gets its turn.
  await h.orch.resume(id, { orchestrationRevision: detail(id).revision })
  await h.until(() => attemptOf(h, id, 'lead').length === 2)
  expect(status(id)).not.toBe('paused')
})

// ------------------------------------------------ item 2: recovered success is never consumable

/** What a database upgraded from before fix-h holds: the step accepted recovered text, its attempt is now unknown. */
const legacyRecovered = (stepId: string, text: string) => {
  h.db.sqlite
    .prepare(
      "UPDATE orc_attempts SET state = 'unknown', unknown_reason = 'recovered_text_only', evidence = NULL, terminated_at = NULL, settled = 0 WHERE step_id = ?",
    )
    .run(stepId)
  h.db.sqlite
    .prepare(
      "UPDATE orc_steps SET status = 'succeeded', disposition = NULL, result = ?, result_revision = 1 WHERE id = ?",
    )
    .run(text, stepId)
}
const chain = {
  script: byTurn({
    1: async (t) => {
      await t.call('orch.assign', { agent: 'builder', instruction: '[fake:hold] write it' })
      await t.call('orch.assign', { agent: 'reviewer', instruction: 'check it', after: ['s1'] })
    },
  }),
}
const stepStatus = (id: string, stepId: string) =>
  detail(id).stepsList.find((s) => s.id === stepId)!.status

test('fix-i 2: upgrade -> Abandon -> Resume never admits a dependent on the recovered result', async () => {
  h = await harness({ lead: chain })
  const id = await h.create({ gatePolicy: 'none' })
  await h.until(() => attemptOf(h, id, 'step', 's1').some((a) => a.state === 'running'))
  await h.orch.pause(id, { orchestrationRevision: detail(id).revision })
  legacyRecovered('s1', 'accepted text')
  await h.orch.recover()
  expect(stepStatus(id, 's1')).toBe('unknown')
  expect(h.rows('SELECT result FROM orc_steps WHERE id = ?', 's1')).toEqual([{ result: null }])
  const a = attemptOf(h, id, 'step', 's1')[0]!
  await h.orch.abandon(id, {
    attemptIds: [a.id],
    orchestrationRevision: detail(id).revision,
    acknowledge: true,
  })
  expect(stepStatus(id, 's1')).toBe('failed')
  await h.orch.resume(id, { orchestrationRevision: detail(id).revision })
  await h.settle(5000)
  expect(attemptOf(h, id, 'step', 's2')).toHaveLength(0)
  expect(stepStatus(id, 's1')).not.toBe('succeeded')
  expect(stepStatus(id, 's2')).not.toBe('admitted')
})

test('fix-i 2: a run that finished on a recovered result becomes finished_with_unresolved', async () => {
  h = await harness({
    lead: {
      script: byTurn({
        1: async (t) => {
          await t.call('orch.assign', { agent: 'builder', instruction: 'one' })
        },
        2: async (t) => {
          await t.call('orch.finish', { outcome: 'success', summary: 'done' })
        },
      }),
    },
  })
  const id = await h.create({ gatePolicy: 'none' })
  await h.until(() => status(id) === 'succeeded')
  legacyRecovered('s1', 'accepted text')
  await h.orch.recover()
  expect(status(id)).toBe('finished_with_unresolved')
  expect(stepStatus(id, 's1')).toBe('unknown')
  // Idempotent: a second start changes nothing.
  const history = h.rows('SELECT COUNT(*) AS n FROM orc_history WHERE orchestration_id = ?', id)
  await h.orch.recover()
  expect(h.rows('SELECT COUNT(*) AS n FROM orc_history WHERE orchestration_id = ?', id)).toEqual(
    history,
  )
})

test('fix-i 2: a dependent that consumed the recovered result is withdrawn and recorded', async () => {
  h = await harness({ lead: chain })
  const id = await h.create({ gatePolicy: 'every-step' })
  await h.until(() => detail(id).gates.length >= 1)
  await h.orch.gateDecision(id, 'g1', {
    decision: 'approve',
    expectedRevision: 1,
    orchestrationRevision: detail(id).revision,
  })
  await h.until(() => attemptOf(h, id, 'step', 's1').some((a) => a.state === 'running'))
  await h.orch.pause(id, { orchestrationRevision: detail(id).revision })
  // s2 is waiting behind its own approved gate when the result turns out to have been synthetic.
  legacyRecovered('s1', 'accepted text')
  h.db.sqlite.prepare("UPDATE orc_steps SET status = 'queued' WHERE id = 's2'").run()
  h.db.sqlite.prepare("UPDATE orc_gates SET status = 'approved' WHERE step_id = 's2'").run()
  await h.orch.recover()
  expect(stepStatus(id, 's2')).toBe('blocked')
  expect(h.rows("SELECT status FROM orc_gates WHERE step_id = 's2'")).toEqual([
    { status: 'withdrawn' },
  ])
  expect(
    h.rows<{ detail: string }>(
      "SELECT detail FROM orc_history WHERE orchestration_id = ? AND kind = 'recovered_result_withdrawn'",
      id,
    ),
  ).toHaveLength(1)
  await h.orch.resume(id, { orchestrationRevision: detail(id).revision })
  await h.settle(5000)
  expect(attemptOf(h, id, 'step', 's2')).toHaveLength(0)
})
