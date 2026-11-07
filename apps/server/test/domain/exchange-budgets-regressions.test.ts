import { expect, test } from 'vitest'
import { h, installExchangeBudgetsHarness, reviewUntilPaused } from './exchange-budgets-helpers.ts'

installExchangeBudgetsHarness()

// Review findings (Sonnet, 11.1c): each left an exchange with nothing running and nothing to decide, or routed work
// after Stop, before the fix.

test('a turn held on the author’s side resumes the review where it was (waiting on the author)', () => {
  h.ask('builder', 'Build it.')
  h.turn('builder', { action: 'review', to: 'reviewer', note: 'Ready.' })
  const review = h.exchanges()[0]!
  h.db.sqlite.prepare('UPDATE exchanges SET budget = 1 WHERE id = ?').run(review.id)
  h.turn('reviewer', { action: 'send_back', note: 'Fix the cursor.' })
  expect(h.exchanges()[0]).toMatchObject({ state: 'paused_budget', round: 2 })
  h.decide(review.id, { option: 'more_turns', turns: 4 })
  expect(h.exchanges()[0]).toMatchObject({ state: 'waiting_on_agent', round: 2 })
  h.turn('builder', { action: 'review', to: 'reviewer', note: 'Fixed.' })
  expect(h.exchanges()).toHaveLength(1)
  expect(h.exchanges()[0]).toMatchObject({ state: 'live', round: 2 })
})

test('stopping a question hands the exchange waiting on its answer to the person: continue or stop', () => {
  h.ask('builder', 'Build it.')
  h.turn('builder', { action: 'review', to: 'reviewer', note: 'Ready.' })
  h.turn('reviewer', { action: 'ask', to: 'designer', question: 'Final?' })
  h.finish(h.start('designer'), 'Partial', 'failed')
  const [review, question] = h.exchanges()
  expect(question!.pause!.reason).toBe('turn_failed')
  h.decide(question!.id, { option: 'stop' })
  expect(h.exchanges()[0]).toMatchObject({
    id: review!.id,
    state: 'waiting_on_you',
    pause: { reason: 'question_stopped', options: ['continue', 'stop'] },
  })
  h.decide(review!.id, { option: 'continue' })
  expect(h.pending()).toMatchObject([{ agent_id: 'reviewer', exchange_id: review!.id }])
  expect(h.exchanges()[0]).toMatchObject({ state: 'live' })
  h.turn('reviewer', { action: 'approve', note: 'Fine without it.' })
  expect(h.exchanges()[0]).toMatchObject({ state: 'done', outcome: 'approved' })
})

test('an answer passed to the lead hands the exchange its asker was in to the person', () => {
  h.ask('builder', 'Build it.')
  h.turn('builder', { action: 'review', to: 'reviewer', note: 'Ready.' })
  h.turn('reviewer', { action: 'ask', to: 'designer', question: 'Final?' })
  h.db.sqlite
    .prepare("UPDATE agent_lifecycle SET state = 'deleting' WHERE agent_id = 'reviewer'")
    .run()
  h.turn('designer', undefined, 'Yes.')
  const [review, question] = h.exchanges()
  h.decide(question!.id, { option: 'answer_to_lead' })
  expect(h.exchanges()[0]).toMatchObject({
    id: review!.id,
    pause: { reason: 'unreachable', options: ['retry', 'reassign', 'stop'] },
  })
  h.db.sqlite
    .prepare("UPDATE agent_lifecycle SET state = 'ready' WHERE agent_id = 'reviewer'")
    .run()
  h.decide(review!.id, { option: 'reassign', to: 'designer' })
  expect(
    h
      .pending()
      .map((row) => row.agent_id)
      .sort(),
  ).toEqual(['designer', 'lead'])
})

test('a turn that completes after Stop routes nothing', () => {
  h.ask('builder', 'Build it.')
  h.turn('builder', { action: 'handoff', to: 'designer', note: 'Yours.' })
  const d = h.start('designer')
  h.act(d, { action: 'handoff', to: 'reviewer', note: 'Over to you.' })
  const stopped = h.stopJob()
  expect(stopped.running).toEqual([{ agentId: 'designer', runId: d.runId }])
  // The stop raced the completion: the turn ends "completed", but its hand-off is dropped.
  h.finish(d, 'Done anyway.')
  expect(h.pending()).toEqual([])
  expect(h.exchanges().filter((x) => x.kind === 'handoff' && x.to === 'reviewer')).toEqual([])
})

test('an answer back to a turn the person started counts against the job limit and is held on the question', () => {
  h.db.sqlite.prepare('UPDATE jobs SET job_turn_limit = 1 WHERE id = ?').run(h.job())
  h.ask('builder', 'Build it.')
  h.turn('builder', { action: 'ask', to: 'designer', question: 'Colour?' })
  h.turn('designer', undefined, 'Coral.')
  const question = h.exchanges()[0]!
  expect(question.pause?.reason).toBe('job_limit')
  expect(h.pending()).toEqual([])
  h.decide(question.id, { option: 'more_turns', turns: 1 })
  expect(h.pending()).toMatchObject([{ agent_id: 'builder', exchange_id: null }])
})

test('more turns on one limit still respects the others: held again with the other reason', () => {
  const review = reviewUntilPaused()
  h.db.sqlite.prepare('UPDATE jobs SET job_turn_limit = 8 WHERE id = ?').run(h.job())
  h.decide(review.id, { option: 'more_turns', turns: 4 })
  expect(h.exchanges()[0]).toMatchObject({ budget: 12, state: 'paused_budget' })
  expect(h.exchanges()[0]!.pause!.reason).toBe('job_limit')
  expect(h.pending()).toEqual([])
})

test('reassign is only offered for the turn of the agent the exchange was opened to, never to its opener', () => {
  h.ask('builder', 'Build it.')
  h.turn('builder', { action: 'review', to: 'reviewer', note: 'Ready.' })
  h.turn('reviewer', { action: 'send_back', note: 'Fix it.' })
  h.finish(h.start('builder'), 'Partial', 'failed')
  expect(h.exchanges()[0]!.pause).toEqual({ reason: 'turn_failed', options: ['retry', 'stop'] })
  h.decide(h.exchanges()[0]!.id, { option: 'retry' })
  h.turn('builder', { action: 'review', to: 'reviewer', note: 'Fixed.' })
  h.finish(h.start('reviewer'), 'Partial', 'failed')
  const review = h.exchanges()[0]!
  expect(review.pause!.options).toContain('reassign')
  expect(() => h.decide(review.id, { option: 'reassign', to: 'builder' })).toThrow(
    /opened this exchange/,
  )
})

test('a released turn whose agent can’t take work is held again, not thrown', () => {
  const review = reviewUntilPaused()
  h.db.sqlite
    .prepare("UPDATE agent_lifecycle SET state = 'deleting' WHERE agent_id = 'reviewer'")
    .run()
  h.decide(review.id, { option: 'more_turns', turns: 4 })
  expect(h.exchanges()[0]!.pause!.reason).toBe('unreachable')
})

test('deciding while the lead is still deciding stops the lead’s turn', () => {
  const review = reviewUntilPaused()
  h.decide(review.id, { option: 'lead_decides' })
  const lead = h.start('lead')
  const decided = h.decide(review.id, { option: 'more_turns', turns: 2 })
  expect(decided.running).toEqual([{ agentId: 'lead', runId: lead.runId }])
  // The lead's turn can't extend any more once the person decided.
  h.finish(lead, 'Extending.')
  expect(h.exchanges()[0]).toMatchObject({ budget: 10, state: 'live' })
})

test('a second hold on an exchange keeps the first held turn and shows the dropped one on the pause', async () => {
  const { hold, heldTurn } = await import('../../src/domain/exchanges/budget.ts')
  const review = reviewUntilPaused()
  const first = heldTurn(h.db.sqlite, review.id)!
  const turn: Omit<typeof first, 'resume'> & { resume?: unknown } = { ...first }
  delete turn.resume
  hold(
    h.db.sqlite,
    review.id,
    'turn_failed',
    { ...turn, agentId: 'designer', input: 'Another turn.' },
    '2026-10-24T10:00:00.000Z',
    "designer's turn failed",
  )
  expect(heldTurn(h.db.sqlite, review.id)).toEqual({ ...first, dropped: ['designer'] })
  expect(h.exchanges()[0]).toMatchObject({
    state: 'paused_budget',
    pause: { reason: 'exchange_budget', droppedAgents: ['designer'] },
  })
})

test('a hold without a turn never erases the held turn or its reason (review)', async () => {
  const { hold, heldTurn } = await import('../../src/domain/exchanges/budget.ts')
  const review = reviewUntilPaused()
  const first = heldTurn(h.db.sqlite, review.id)!
  for (const reason of ['no_decision', 'author_stalled'] as const)
    hold(h.db.sqlite, review.id, reason, null, '2026-10-24T10:00:00.000Z', 'later')
  expect(heldTurn(h.db.sqlite, review.id)).toEqual(first)
  expect(h.exchanges()[0]).toMatchObject({
    state: 'paused_budget',
    pause: { reason: 'exchange_budget' },
  })
  expect(h.exchanges()[0]!.pause!.droppedAgents).toBeUndefined()
})

test('3.30.1: a paused exchange is a decision (the job needsYou); deciding clears it, and a finished turn is only the person’s turn', () => {
  const review = reviewUntilPaused()
  expect(h.jobView()).toMatchObject({ state: 'waiting_on_you', needsYou: true })
  h.decide(review.id, { option: 'more_turns', turns: 4 })
  expect(h.jobView().needsYou).toBe(false)
  // The reviewer passes it: the exchange ends, the agents are done, and it is the person's turn — no decision.
  h.turn('reviewer', { action: 'approve', note: 'Good.' })
  for (let i = 0; i < 5 && h.pending().length; i++) h.turn(h.pending()[0]!.agent_id)
  expect(h.jobView()).toMatchObject({ state: 'waiting_on_you', needsYou: false })
})
