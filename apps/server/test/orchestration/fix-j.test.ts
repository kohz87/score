import { afterEach, expect, test } from 'vitest'
import { byTurn } from '../../src/hermes/fake/fake-lead.ts'
import { attemptOf, harness, type Harness } from './harness.ts'

let h: Harness
afterEach(async () => {
  await h?.close()
  h = undefined as never
})
const detail = (id: string) => h.orch.snapshot(id).orchestration
const stepStatus = (id: string, stepId: string) =>
  detail(id).stepsList.find((s) => s.id === stepId)!.status

const chain = {
  script: byTurn({
    1: async (t) => {
      await t.call('orch.assign', { agent: 'builder', instruction: '[fake:hold] write it' })
      await t.call('orch.assign', { agent: 'reviewer', instruction: 'check it', after: ['s1'] })
    },
  }),
}

/** What a database upgraded from before fix-h holds: s1 accepted recovered text, its attempt is now unknown. */
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

/** The crash boundary between claim and send: s2 is admitted, its attempt exists and was never sent. */
const admitConsumer = (orchId: string, state: string, input: string) => {
  const sqlite = h.db.sqlite
  sqlite.prepare("UPDATE orc_steps SET status = 'admitted' WHERE id = 's2'").run()
  const t = sqlite
    .prepare("SELECT * FROM orc_attempts WHERE step_id = 's1' ORDER BY n DESC LIMIT 1")
    .get() as Record<string, string | number>
  const id = `orc-${orchId.slice(4)}-s2-1`
  sqlite
    .prepare(
      `INSERT INTO orc_attempts (id, orchestration_id, kind, step_id, n, agent_id, agent_incarnation, session_id, turn_id, message_id,
         state, input, reserved_usd, created_at, updated_at)
       VALUES (?, ?, 'step', 's2', 1, 'reviewer', ?, ?, ?, ?, ?, ?, 0.5, ?, ?)`,
    )
    .run(
      id,
      orchId,
      sqlite.prepare("SELECT agent_incarnation AS i FROM orc_steps WHERE id = 's2'").get()![
        'i'
      ] as string,
      id,
      `orc-turn-${id}`,
      `reply:orc-turn-${id}`,
      state,
      input,
      t['created_at'] as string,
      t['updated_at'] as string,
    )
  return id
}
const attemptRow = (id: string) =>
  h.rows<{ state: string; run_id: string | null; unknown_reason: string | null }>(
    'SELECT state, run_id, unknown_reason FROM orc_attempts WHERE id = ?',
    id,
  )[0]!

const setup = async () => {
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
  return id
}

test('fix-j 1: upgrade -> repair -> Abandon -> Resume never sends an unsent consumer of withdrawn text', async () => {
  const id = await setup()
  legacyRecovered('s1', 'accepted text')
  const a2 = admitConsumer(id, 'created', 'Result of s1: accepted text')
  h.db.sqlite.prepare("UPDATE orc_gates SET status = 'approved' WHERE step_id = 's2'").run()
  await h.orch.recover()
  expect(attemptRow(a2).state).toBe('refused')
  expect(attemptRow(a2).unknown_reason).toContain('input_withdrawn')
  expect(stepStatus(id, 's2')).toBe('blocked')
  expect(h.rows("SELECT status FROM orc_gates WHERE step_id = 's2'")).toEqual([
    { status: 'withdrawn' },
  ])
  const a1 = attemptOf(h, id, 'step', 's1')[0]!
  await h.orch.abandon(id, {
    attemptIds: [a1.id],
    orchestrationRevision: detail(id).revision,
    acknowledge: true,
  })
  await h.orch.resume(id, { orchestrationRevision: detail(id).revision })
  await h.settle(5000)
  expect(attemptRow(a2).state).toBe('refused')
  expect(attemptRow(a2).run_id).toBeNull()
  expect(stepStatus(id, 's2')).toBe('blocked')
})

test('fix-j 2: a consumer whose dependency result revision changed after claim never sends', async () => {
  const id = await setup()
  // s1 holds a genuine result (revision 1); s2 was claimed on it and its revisions were frozen.
  h.db.sqlite
    .prepare(
      "UPDATE orc_attempts SET state = 'terminated', evidence = 'completed', terminated_at = '2026-01-01T00:00:00.000Z', settled = 1 WHERE step_id = 's1'",
    )
    .run()
  h.db.sqlite
    .prepare(
      "UPDATE orc_steps SET status = 'succeeded', result = 'first answer', result_revision = 1 WHERE id = 's1'",
    )
    .run()
  const a2 = admitConsumer(id, 'created', 'Result of s1: first answer')
  h.db.sqlite
    .prepare(
      "INSERT INTO orc_history (orchestration_id, kind, detail, at) VALUES (?, 'step_input_frozen', ?, '2026-01-01T00:00:00.000Z')",
    )
    .run(id, JSON.stringify({ attemptId: a2, revisions: { s1: 1 } }))
  // The result changes afterwards (a later accepted result, revision 2).
  h.db.sqlite
    .prepare("UPDATE orc_steps SET result = 'second answer', result_revision = 2 WHERE id = 's1'")
    .run()
  await h.orch.resume(id, { orchestrationRevision: detail(id).revision })
  await h.settle(5000)
  expect(attemptRow(a2).state).toBe('refused')
  expect(attemptRow(a2).run_id).toBeNull()
  expect(stepStatus(id, 's2')).toBe('blocked')
})

test('fix-j 3: an already-sent consumer is only recorded', async () => {
  const id = await setup()
  legacyRecovered('s1', 'accepted text')
  const a2 = admitConsumer(id, 'running', 'Result of s1: accepted text')
  await h.orch.recover()
  expect(attemptRow(a2).state).toBe('running')
  const history = h.rows<{ detail: string }>(
    "SELECT detail FROM orc_history WHERE orchestration_id = ? AND kind = 'recovered_result_withdrawn'",
    id,
  )
  expect(history).toHaveLength(1)
  const parsed = JSON.parse(history[0]!.detail) as { sentConsumers?: { stepId: string }[] }
  expect(parsed.sentConsumers?.map((c) => c.stepId)).toEqual(['s2'])
})
