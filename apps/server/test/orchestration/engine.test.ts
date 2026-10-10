import type { OrchReceipt } from '@score/contract'
import { afterEach, expect, test } from 'vitest'
import { byTurn, type LeadScript } from '../../src/hermes/fake/fake-lead.ts'
import { attemptOf, endRun, harness, type Harness } from './harness.ts'

let h: Harness
afterEach(async () => {
  await h?.close()
  h = undefined as never
})

const status = (id: string) => h.orch.summary(id).status
const steps = (id: string) => h.orch.snapshot(id).orchestration.stepsList
const asReceipt = (value: unknown) => value as OrchReceipt
/** A lead that records every receipt it got, per turn. */
function recording(script: Record<number, (calls: OrchReceipt[]) => LeadScript>) {
  const log: Record<number, OrchReceipt[]> = {}
  const lead = byTurn(
    Object.fromEntries(
      Object.entries(script).map(([turn, make]) => [
        turn,
        async (t) => {
          log[Number(turn)] = []
          const wrapped = {
            ...t,
            call: async (...args: Parameters<typeof t.call>) => {
              const result = await t.call(...args)
              log[Number(turn)]!.push(asReceipt(result))
              return result
            },
          }
          return make(log[Number(turn)]!)(wrapped)
        },
      ]),
    ),
  )
  return { lead, log }
}

test('the event loop: lead plans, steps run in order, the lead is woken and finishes', async () => {
  h = await harness()
  const id = await h.create()
  await h.until(() => status(id) === 'succeeded')
  const detail = h.orch.snapshot(id).orchestration
  expect(detail.stepsList.map((step) => [step.id, step.status])).toEqual([
    ['s1', 'succeeded'],
    ['s2', 'succeeded'],
  ])
  expect(detail.stepsList[1]!.after).toEqual(['s1'])
  expect(detail.attempts.filter((a) => a.kind === 'lead').length).toBe(3)
  expect(detail.attempts.every((a) => a.state === 'terminated' && a.evidence === 'completed')).toBe(
    true,
  )
  expect(detail.finish?.outcome).toBe('success')
  expect(detail.ownership).toBe('released')
  // s2 started only after s1's result existed, and its input carried that result as quoted data.
  const s2 = h.rows<{ input: string }>("SELECT input FROM orc_attempts WHERE step_id = 's2'")[0]!
  expect(s2.input).toContain('<<<RESULT s1')
  // The room shows the run: the goal, the lead's note and the replies; the brief follows the run.
  const brief = h.rows<{ status: string }>(
    'SELECT emitted_status AS status FROM briefs WHERE id = ?',
    detail.briefId,
  )[0]!
  expect(brief.status).toBe('done')
})

test('events that arrive while a lead attempt runs are delivered in the next attempt, never a second concurrent one', async () => {
  h = await harness({
    lead: {
      script: byTurn({
        1: async (t) => {
          await t.call('orch.assign', { agent: 'builder', instruction: 'one' })
          await t.call('orch.assign', { agent: 'reviewer', instruction: 'two' })
          return 'ok'
        },
        2: async (t) => {
          await t.call('orch.finish', { outcome: 'success', summary: 'done' })
        },
      }),
    },
  })
  const id = await h.create({ gatePolicy: 'none' })
  // Wait until turn 1 is running, then pile two more causes on while it still runs.
  await h.until(() => attemptOf(h, id, 'lead').some((a) => a.state === 'running'))
  h.db.sqlite
    .prepare(
      "INSERT INTO orc_causes (orchestration_id, kind, ref, at) VALUES (?, 'step_succeeded', 'sX', ?), (?, 'step_succeeded', 'sY', ?)",
    )
    .run(id, '2026-01-01T12:00:00.000Z', id, '2026-01-01T12:00:00.000Z')
  await h.orch.pump()
  expect(attemptOf(h, id, 'lead')).toHaveLength(1)
  await h.until(() => status(id) === 'succeeded')
  const leads = attemptOf(h, id, 'lead')
  expect(leads.length).toBeLessThanOrEqual(3)
  // The attempt after turn 1 claimed several causes at once.
  const claims = h.rows<{ claim_from: number; claim_to: number }>(
    "SELECT claim_from, claim_to FROM orc_attempts WHERE kind = 'lead' ORDER BY n",
  )
  expect(claims[1]!.claim_to - claims[1]!.claim_from).toBeGreaterThanOrEqual(2)
})

test('refusals come back as receipts: allowed agents, lead as step agent, dependencies, replaces, capability text, step limit', async () => {
  const { lead, log } = recording({
    1: () => async (t) => {
      await t.call('orch.assign', { agent: 'stranger', instruction: 'x' })
      await t.call('orch.assign', { agent: 'lead', instruction: 'x' })
      await t.call('orch.assign', { agent: 'builder', instruction: 'x', after: ['s9'] })
      await t.call('orch.assign', { agent: 'builder', instruction: 'x', replaces: 's9' })
      await t.call('orch.assign', { agent: 'builder', instruction: `leak ${t.capability}` })
      await t.call('orch.assign', { agent: 'builder', instruction: 'fine' })
      await t.call('orch.assign', { agent: 'builder', instruction: 'one too many' })
      await t.call('orch.finish', { outcome: 'partial', summary: 'enough' })
    },
  })
  h = await harness({ lead: { script: lead } })
  const id = await h.create({ maxSteps: 1 })
  await h.until(() => status(id) === 'succeeded' || status(id) === 'finished_with_unresolved')
  expect(log[1]!.map((r) => r.code ?? r.status)).toEqual([
    'agent_not_allowed',
    'agent_not_allowed',
    'bad_dependency',
    'bad_replaces',
    'capability_in_text',
    'ok',
    'step_limit',
    'ok',
  ])
  // Refusals are stored receipts (the lead can look them up), and the refused ones created nothing.
  expect(steps(id)).toHaveLength(1)
})

test('limits: at most 20 commands per lead attempt, bounded plan entries', async () => {
  const { lead, log } = recording({
    1: () => async (t) => {
      for (let i = 0; i < 22; i++) await t.call('orch.note', { text: `n${i}` })
      await t.call('orch.finish', { outcome: 'success', summary: 'x' })
    },
  })
  h = await harness({ lead: { script: lead } })
  const id = await h.create()
  await h.until(() => ['succeeded', 'paused'].includes(status(id)))
  expect(log[1]!.filter((r) => r.status === 'ok')).toHaveLength(20)
  expect(log[1]!.slice(20).map((r) => r.code)).toEqual([
    'command_limit',
    'command_limit',
    'command_limit',
  ])
  expect(h.rows('SELECT 1 FROM orc_commands')).toHaveLength(20)
  // The 21st and 22nd notes never reached the room.
  expect(h.rows("SELECT id FROM messages WHERE id LIKE 'orc-note:%'")).toHaveLength(20)
})

test('a failed step blocks its dependents, wakes the lead, and a replacement says replaces', async () => {
  const { lead, log } = recording({
    1: () => async (t) => {
      await t.call('orch.assign', { agent: 'builder', instruction: 'break me' })
      await t.call('orch.assign', { agent: 'reviewer', instruction: 'review', after: ['s1'] })
    },
    2: () => async (t) => {
      // s1 failed, s2 is blocked: the lead sees both and replaces s1.
      expect(t.steps.map((s) => [s.id, s.status])).toEqual([
        ['s1', 'failed'],
        ['s2', 'blocked'],
      ])
      await t.call('orch.assign', { agent: 'builder', instruction: 'retry', replaces: 's1' })
      const again = await t.call('orch.assign', {
        agent: 'builder',
        instruction: 'retry again',
        replaces: 's1',
      })
      expect(asReceipt(again).code).toBe('bad_replaces')
    },
    3: () => async (t) => {
      await t.call('orch.finish', { outcome: 'partial', summary: 'recovered' })
    },
  })
  h = await harness({ lead: { script: lead } })
  const id = await h.create()
  await h.until(() => attemptOf(h, id, 'step', 's1').some((a) => a.runId !== null))
  // Hermes reports the failure before the step can complete.
  await endRun(h, attemptOf(h, id, 'step', 's1')[0]!.runId!, 'failed', 'it broke')
  await h.until(() => status(id) === 'succeeded' || status(id) === 'failed')
  const all = steps(id)
  expect(all.map((s) => [s.id, s.status])).toEqual([
    ['s1', 'failed'],
    ['s2', 'blocked'],
    ['s3', 'succeeded'],
  ])
  expect(all[0]!.result).toContain('it broke')
  expect(all[1]!.disposition).toContain('dependency s1')
  expect(all[2]!.replaces).toBe('s1')
  expect(log[2]).toBeDefined()
})

test('a lead turn that does nothing and leaves no wake source pauses the run for the person', async () => {
  h = await harness({ lead: { script: async () => 'I have nothing to do.' } })
  const id = await h.create()
  await h.until(() => status(id) === 'paused')
  const summary = h.orch.summary(id)
  expect(summary.pauseReason).toBe('no_wake_source')
  expect(summary.needsYou).toContainEqual({ kind: 'paused', reason: 'no_wake_source' })
  // No extra lead turn was spent on it.
  expect(attemptOf(h, id, 'lead')).toHaveLength(1)
  // Resume cannot invent a wake source: it pauses again.
  const detail = h.orch.snapshot(id).orchestration
  await h.orch.resume(id, { orchestrationRevision: detail.revision })
  await h.settle()
  expect(status(id)).toBe('paused')
  // The person ends it.
  await h.orch.stop(id)
  await h.until(() => status(id) === 'stopped' || status(id) === 'stopping')
})

test('when the lead turns are used up with work pending, the run pauses without spending another turn', async () => {
  const { lead } = recording({
    1: () => async (t) => {
      await t.call('orch.assign', { agent: 'builder', instruction: 'only step' })
    },
  })
  h = await harness({ lead: { script: lead } })
  const id = await h.create({ maxLeadTurns: 1 })
  await h.until(() => status(id) === 'paused')
  expect(h.orch.summary(id).pauseReason).toBe('turns_exhausted')
  expect(steps(id)[0]!.status).toBe('succeeded')
  expect(attemptOf(h, id, 'lead')).toHaveLength(1)
})

test('repeated lead failures pause the run (lead_failing) instead of looping', async () => {
  h = await harness({ lead: { script: async () => 'nothing' } })
  const id = await h.create()
  // The lead's run fails twice in a row.
  for (let n = 1; n <= 2; n++) {
    await h.until(
      () =>
        attemptOf(h, id, 'lead').length === n && attemptOf(h, id, 'lead')[n - 1]!.runId !== null,
    )
    const run = attemptOf(h, id, 'lead')[n - 1]!.runId!
    await endRun(h, run, 'failed', 'model error')
    await h.settle()
  }
  await h.until(() => status(id) === 'paused')
  expect(h.orch.summary(id).pauseReason).toBe('lead_failing')
  expect(attemptOf(h, id, 'lead')).toHaveLength(2)
})

test('typed dispatch: a reply that mentions agents creates no hand-off, no plan and no extra run', async () => {
  h = await harness({
    lead: {
      script: byTurn({
        1: async (t) => {
          await t.call('orch.assign', { agent: 'builder', instruction: 'work' })
          return '@reviewer @builder please take over. Plan:\n1. do a thing\n2. do another thing'
        },
        2: async (t) => {
          await t.call('orch.finish', { outcome: 'success', summary: 'x' })
          return '@reviewer thanks'
        },
      }),
      stepReply: () => '@lead I am done. @reviewer look at this',
    },
  })
  const id = await h.create({ gatePolicy: 'none' })
  await h.until(() => status(id) === 'succeeded')
  const attempts = h.orch.snapshot(id).orchestration.attempts.length
  expect(h.rows('SELECT 1 FROM message_runs')).toHaveLength(attempts)
  expect(h.rows("SELECT 1 FROM events WHERE type = 'handoff.created'")).toHaveLength(0)
  expect(
    h.rows('SELECT 1 FROM message_runs WHERE hop > 0 OR from_agent_id IS NOT NULL'),
  ).toHaveLength(0)
  // The replies are in the room as ordinary agent messages, tagged to their runs, with no plan card.
  const parts = h
    .rows<{ parts: string }>("SELECT parts FROM messages WHERE author_kind = 'agent'")
    .map((row) => row.parts)
    .join('\n')
  expect(parts).toContain('please take over')
  expect(parts).not.toContain('"kind":"plan"')
})
