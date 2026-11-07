import { expect, test } from 'vitest'
import { h, installExchangeBudgetsHarness } from './exchange-budgets-helpers.ts'

installExchangeBudgetsHarness()

// §4.6: every wait has an exit, one test per row.

test('§4.6 row 1: the target’s turn failed → card with retry · reassign · stop; retry and reassign work', () => {
  h.ask('builder', 'Build it.')
  h.turn('builder', { action: 'handoff', to: 'designer', note: 'Draw it.' })
  const d = h.start('designer')
  h.finish(d, 'Partial', 'failed')
  const handoff = h.exchanges()[0]!
  expect(handoff).toMatchObject({
    state: 'waiting_on_you',
    endedReason: "designer's turn failed",
    pause: { reason: 'turn_failed', options: ['retry', 'reassign', 'stop'] },
  })
  h.decide(handoff.id, { option: 'retry' })
  expect(h.pending()).toMatchObject([{ agent_id: 'designer', exchange_id: handoff.id }])
  h.finish(h.start('designer'), 'Failed again', 'failed')
  h.decide(handoff.id, { option: 'reassign', to: 'reviewer' })
  expect(h.pending()).toMatchObject([{ agent_id: 'reviewer', exchange_id: handoff.id }])
  expect(h.exchanges()[0]).toMatchObject({ to: 'reviewer', state: 'live' })
})

test('§4.6 row 2: the asker can’t take the answer → card with retry · answer to lead · stop', () => {
  h.ask('builder', 'Build it.')
  h.turn('builder', { action: 'ask', to: 'designer', question: 'Colour?' })
  h.db.sqlite
    .prepare("UPDATE agent_lifecycle SET state = 'deleting' WHERE agent_id = 'builder'")
    .run()
  h.turn('designer', undefined, 'Coral.')
  const question = h.exchanges()[0]!
  expect(question).toMatchObject({
    state: 'waiting_on_you',
    endedReason: "builder can't take the answer right now",
    pause: { reason: 'asker_gone', options: ['retry', 'answer_to_lead', 'stop'] },
  })
  h.decide(question.id, { option: 'answer_to_lead' })
  expect(h.pending()).toMatchObject([{ agent_id: 'lead', exchange_id: null }])
  expect(h.pending()[0]!.input).toContain('> Coral.')
  expect(h.exchanges()[0]).toMatchObject({ state: 'done', outcome: 'answered' })
})

test('§4.6 row 3: a turn queued behind the agent’s turn in another job shows who it waits for', () => {
  h.ask('builder', 'Build it.')
  h.turn('builder', { action: 'handoff', to: 'designer', note: 'Draw it.' })
  // designer is busy in another job of the same room.
  const other = h.db.tx((sqlite) => {
    sqlite
      .prepare(
        "INSERT INTO jobs (id, room_id, title, session_scheme, created_at, updated_at) VALUES ('job_other', 'team', 'Other', 'job', ?, ?)",
      )
      .run(h.tick(), h.tick())
    return 'job_other'
  })
  h.db.sqlite
    .prepare(
      `INSERT INTO message_runs (message_id, room_id, agent_id, chain_id, hop, turn_id, parent_message_id, input, agents,
         created_at, state, job_id, run_id)
       VALUES ('reply:busy', 'team', 'designer', 'm1', 0, 'busy', 'm1', 'x', '[]', ?, 'active', ?, NULL)`,
    )
    .run(h.tick(), other)
  expect(h.exchanges()[0]!.queuedBehind).toEqual({ agentId: 'designer', since: expect.any(String) })
  expect(h.exchanges()[0]!.pause).toBeNull()
})

test('§4.6 row 4: the reviewer didn’t decide → card with ask again · send back · close; each works', () => {
  h.ask('builder', 'Build it.')
  h.turn('builder', { action: 'review', to: 'reviewer', note: 'Ready.' })
  h.turn('reviewer', undefined, 'Hmm, not sure.')
  const review = h.exchanges()[0]!
  expect(review.pause).toEqual({
    reason: 'no_decision',
    options: ['ask_again', 'send_back', 'close'],
  })
  h.decide(review.id, { option: 'ask_again' })
  expect(h.pending()).toMatchObject([{ agent_id: 'reviewer', exchange_id: review.id }])
  h.turn('reviewer', undefined, 'Still unsure.')
  h.decide(review.id, { option: 'send_back', note: 'Add a test for the cursor.' })
  expect(h.pending()).toMatchObject([{ agent_id: 'builder' }])
  expect(h.pending()[0]!.input).toContain('Add a test for the cursor.')
  expect(h.exchanges()[0]).toMatchObject({ round: 2, state: 'waiting_on_agent' })
  h.turn('builder', { action: 'review', to: 'reviewer', note: 'Added.' })
  h.turn('reviewer', undefined, 'No idea.')
  h.decide(review.id, { option: 'close' })
  expect(h.exchanges()[0]).toMatchObject({ state: 'done', outcome: 'no_decision', pause: null })
})

test('§4.6 row 5: Stop on the job stops every open exchange and its turns', () => {
  h.ask('builder', 'Build it.')
  h.turn('builder', { action: 'handoff', to: 'designer', note: 'Draw it.' })
  h.turn('designer', { action: 'ask', to: 'reviewer', question: 'Which one?' })
  const reviewer = h.start('reviewer')
  const stopped = h.stopJob()
  expect(
    h
      .exchanges()
      .filter((x) => x.state !== 'done')
      .map((x) => x.state),
  ).toEqual(['stopped'])
  expect(stopped.running).toEqual([{ agentId: 'reviewer', runId: reviewer.runId }])
  expect(h.pending()).toEqual([])
  expect(h.jobRow().state).toBe('waiting_on_you')
})

test('an author who doesn’t send it back gets a card with ask again · close', () => {
  h.ask('builder', 'Build it.')
  h.turn('builder', { action: 'review', to: 'reviewer', note: 'Ready.' })
  h.turn('reviewer', { action: 'send_back', note: 'Fix the cursor.' })
  h.turn('builder', undefined, 'I think it is fine as is.')
  const review = h.exchanges()[0]!
  expect(review.pause).toEqual({ reason: 'author_stalled', options: ['ask_again', 'close'] })
  h.decide(review.id, { option: 'ask_again' })
  expect(h.pending()).toMatchObject([{ agent_id: 'builder', exchange_id: review.id }])
})
