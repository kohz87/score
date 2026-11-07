import { expect, test } from 'vitest'
import { h, installExchangeBudgetsHarness, reviewUntilPaused } from './exchange-budgets-helpers.ts'

// PLAN 11.1c done-when (docs/briefs/11.1c-budgets.md): budgets, pause-and-ask, step in, and every wait's exit (§4.6).

installExchangeBudgetsHarness()

test('an exchange pauses at 8 of 8 turns with a needs-you card', () => {
  const review = reviewUntilPaused()
  expect(review).toMatchObject({
    turnsUsed: 8,
    budget: 8,
    state: 'paused_budget',
    pause: {
      reason: 'exchange_budget',
      options: ['more_turns', 'lead_decides', 'step_in', 'stop'],
    },
  })
  expect(h.pending()).toEqual([])
  expect(h.jobRow().state).toBe('waiting_on_you')
})

test('"Give 4 more" raises the budget and the held turn goes on', () => {
  const review = reviewUntilPaused()
  h.decide(review.id, { option: 'more_turns', turns: 4 })
  expect(h.exchanges()[0]).toMatchObject({ budget: 12, state: 'live', pause: null })
  expect(h.pending()).toMatchObject([{ agent_id: 'reviewer', exchange_id: review.id }])
  expect(h.pending()[0]!.input).toContain('Try again.')
  expect(h.jobRow().state).toBe('working')
})

test('"Let lead decide": the lead extends once; the next pause goes to the person', () => {
  const review = reviewUntilPaused()
  h.decide(review.id, { option: 'lead_decides' })
  expect(h.pending()).toMatchObject([{ agent_id: 'lead', exchange_id: null }])
  expect(h.pending()[0]!.input).toContain('score_extend')
  // Only the lead's deciding turn may decide; it may not route anything else.
  const lead = h.start('lead')
  expect(h.act(lead, { action: 'handoff', to: 'designer', note: 'x' }).code).toBe('not_allowed')
  expect(h.act(lead, { action: 'extend', turns: 9, note: 'x' }).code).toBe('not_allowed')
  expect(h.act(lead, { action: 'extend', turns: 2, note: 'One more round.' }).status).toBe('staged')
  h.finish(lead, 'Extending.')
  expect(h.exchanges()[0]).toMatchObject({ budget: 10, state: 'live' })
  expect(h.pending()).toMatchObject([{ agent_id: 'reviewer' }])
  // The lead's turn was not the exchange's spend.
  expect(h.exchanges()[0]!.turnsUsed).toBe(8)
  h.turn('reviewer', { action: 'send_back', note: 'Still no.' })
  h.turn('builder', { action: 'review', to: 'reviewer', note: 'Again.' })
  expect(h.exchanges()[0]).toMatchObject({ state: 'paused_budget' })
  expect(h.exchanges()[0]!.pause!.options).not.toContain('lead_decides')
})

test('the lead is never offered when it is in the exchange', () => {
  h.ask('lead', 'Plan it.')
  h.turn('lead', { action: 'review', to: 'reviewer', note: 'Check the plan.' })
  const review = h.exchanges()[0]!
  h.db.sqlite
    .prepare(
      "UPDATE exchanges SET state = 'paused_budget', pause_reason = 'exchange_budget' WHERE id = ?",
    )
    .run(review.id)
  expect(h.exchanges()[0]!.pause!.options).toEqual(['more_turns', 'step_in', 'stop'])
})

test('"Step in" stores the person’s message in the job and sends the held turn on with it, not counted', () => {
  const review = reviewUntilPaused()
  h.decide(review.id, { option: 'step_in', text: 'Ship it with page size 25.' })
  const said = h.db.sqlite
    .prepare(
      "SELECT job_id FROM messages WHERE author_kind = 'you' AND parts LIKE '%page size 25%'",
    )
    .get()
  expect(said).toEqual({ job_id: h.job() })
  expect(h.pending()[0]!.input).toContain('The person stepped in:\nShip it with page size 25.')
  expect(h.exchanges()[0]).toMatchObject({ budget: 9, state: 'live' })
})

test('"Stop" stops the exchange and its open children; queued turns go, running ones are returned to stop', () => {
  h.ask('builder', 'Build it.')
  h.turn('builder', { action: 'review', to: 'reviewer', note: 'Ready.' })
  const reviewer = h.start('reviewer')
  h.act(reviewer, { action: 'ask', to: 'designer', question: 'Final?' })
  h.finish(reviewer, 'Asking.')
  const [review, question] = h.exchanges()
  const designer = h.start('designer')
  h.db.sqlite
    .prepare(
      "UPDATE exchanges SET state = 'paused_budget', pause_reason = 'exchange_budget' WHERE id = ?",
    )
    .run(review!.id)
  const stopped = h.decide(review!.id, { option: 'stop' })
  expect(h.exchanges().map((x) => [x.id, x.state, x.endedReason])).toEqual([
    [review!.id, 'stopped', 'stopped by you'],
    [question!.id, 'stopped', 'stopped by you'],
  ])
  expect(stopped.running).toEqual([{ agentId: 'designer', runId: designer.runId }])
})

test('a decision the exchange does not offer is refused', () => {
  const review = reviewUntilPaused()
  expect(() => h.decide(review.id, { option: 'retry' })).toThrow(/isn’t open/)
})

test('the job-wide turn limit stops repeated hand-offs and nested asks', () => {
  h.db.sqlite.prepare('UPDATE jobs SET job_turn_limit = 5 WHERE id = ?').run(h.job())
  h.ask('builder', 'Pass it around.')
  h.turn('builder', { action: 'handoff', to: 'designer', note: 'Yours.' })
  for (let i = 0; i < 10 && h.pending().length; i++) {
    const next = h.pending()[0]!.agent_id
    h.turn(next, {
      action: 'handoff',
      to: next === 'designer' ? 'builder' : 'designer',
      note: 'Yours.',
    })
  }
  const paused = h.exchanges().find((x) => x.state === 'paused_budget')!
  expect(paused.pause!.reason).toBe('job_limit')
  expect(h.exchanges().reduce((sum, x) => sum + x.turnsUsed, 0)).toBe(5)
  h.decide(paused.id, { option: 'more_turns', turns: 2 })
  expect(h.jobRow().job_turn_limit).toBe(7)
  expect(h.pending()).toHaveLength(1)
})

test('nested asks draw from the same job limit', () => {
  h.db.sqlite.prepare('UPDATE jobs SET job_turn_limit = 2 WHERE id = ?').run(h.job())
  h.ask('builder', 'Build it.')
  h.turn('builder', { action: 'ask', to: 'designer', question: 'Colour?' })
  h.turn('designer', { action: 'ask', to: 'reviewer', question: 'Which one did we agree?' })
  h.turn('reviewer', undefined, 'Coral.')
  // The answer back to designer is the job's third agent-started turn.
  const held = h.exchanges().find((x) => x.state === 'paused_budget')
  expect(held?.pause?.reason).toBe('job_limit')
})

test('a spend cap pauses before the next turn would cross it', () => {
  h.db.sqlite.prepare('UPDATE jobs SET spend_cap_usd = 1 WHERE id = ?').run(h.job())
  h.ask('builder', 'Build it.')
  const b = h.start('builder')
  h.act(b, { action: 'handoff', to: 'designer', note: 'Yours.' })
  h.db.sqlite.prepare('UPDATE runs SET cost_usd = 0.6 WHERE id = ?').run(b.runId)
  h.finish(b, 'Done.')
  // 0.60 settled + 0.50 reserved for the next turn > 1.00.
  const paused = h.exchanges()[0]!
  expect(paused.pause).toEqual({ reason: 'spend_cap', options: ['more_spend', 'step_in', 'stop'] })
  h.decide(paused.id, { option: 'more_spend', usd: 2 })
  expect(h.jobRow().spend_cap_usd).toBe(3)
  expect(h.pending()).toMatchObject([{ agent_id: 'designer' }])
})

test('with a spend cap, a run of unknown cost pauses until the person accepts it', () => {
  h.db.sqlite.prepare('UPDATE jobs SET spend_cap_usd = 100 WHERE id = ?').run(h.job())
  h.ask('builder', 'Build it.')
  const b = h.start('builder')
  h.act(b, { action: 'handoff', to: 'designer', note: 'Yours.' })
  h.db.sqlite
    .prepare("UPDATE runs SET cost_usd = NULL, cost_kind = 'unknown' WHERE id = ?")
    .run(b.runId)
  h.finish(b, 'Done.')
  const paused = h.exchanges()[0]!
  expect(paused.pause!.reason).toBe('cost_unknown')
  h.decide(paused.id, { option: 'continue' })
  expect(h.pending()).toMatchObject([{ agent_id: 'designer' }])
  // The same unknown run doesn't pause the next turn again.
  h.turn('designer', { action: 'handoff', to: 'builder', note: 'Back to you.' })
  expect(h.pending()).toMatchObject([{ agent_id: 'builder' }])
})
