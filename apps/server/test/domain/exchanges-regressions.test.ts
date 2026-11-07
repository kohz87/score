import { expect, test } from 'vitest'
import { listExchanges } from '../../src/domain/exchanges/store.ts'
import { failMessageRun } from '../../src/domain/message-runs.ts'
import {
  act,
  ask,
  db,
  finish,
  installExchangesHarness,
  job,
  jobState,
  pending,
  start,
  tick,
} from './exchanges-helpers.ts'

installExchangesHarness()

// Review findings (Sonnet, 11.1b): each case left an exchange stuck or lost a turn before the fix.

test('a turn that fails before it starts hands its exchange to the person', () => {
  ask('builder', 'Build it.')
  const b = start('builder')
  act(b, { action: 'handoff', to: 'designer', note: 'Draw it.' })
  finish(b, 'Over to designer.')
  const turn = db.sqlite
    .prepare("SELECT turn_id FROM message_runs WHERE agent_id = 'designer' AND state = 'pending'")
    .get() as { turn_id: string }
  failMessageRun(db.sqlite, turn.turn_id, 'session_busy', tick())
  expect(listExchanges(db.sqlite, job())[0]).toMatchObject({
    kind: 'handoff',
    state: 'waiting_on_you',
    endedReason: "designer's turn failed",
  })
  expect(jobState()).toMatchObject({ state: 'waiting_on_you' })
})

test('the target of a hand-off can ask a question; the hand-off ends and the answer comes back', () => {
  ask('builder', 'Build it.')
  const b = start('builder')
  act(b, { action: 'handoff', to: 'designer', note: 'Draw it.' })
  finish(b, 'Over to designer.')
  const d = start('designer')
  act(d, { action: 'ask', to: 'reviewer', question: 'Which palette?' })
  finish(d, 'Asking.')
  const [handoff, question] = listExchanges(db.sqlite, job())
  expect(handoff).toMatchObject({ state: 'done', outcome: 'handed_off' })
  expect(question).toMatchObject({ kind: 'ask', parentId: null, state: 'live' })
  finish(start('reviewer'), 'The warm one.')
  expect(pending()).toMatchObject([{ agent_id: 'designer', exchange_id: null }])
})

test('a reviewer may ask before deciding; the review stays open and the decision still counts', () => {
  ask('builder', 'Build it.')
  db.sqlite.prepare("UPDATE jobs SET holder_agent_id = 'builder' WHERE id = ?").run(job())
  const b = start('builder')
  act(b, { action: 'review', to: 'reviewer', note: 'Ready.' })
  finish(b, 'Done.')
  const r = start('reviewer')
  act(r, { action: 'ask', to: 'designer', question: 'Is the empty state final?' })
  finish(r, 'Checking with designer.')
  const review = listExchanges(db.sqlite, job())[0]!
  expect(review).toMatchObject({ state: 'waiting_on_agent', outcome: null, endedReason: null })
  finish(start('designer'), 'Yes, final.')
  expect(listExchanges(db.sqlite, job())[0]).toMatchObject({ state: 'live' })
  const r2 = start('reviewer')
  expect(act(r2, { action: 'approve', note: 'Good.' }).status).toBe('staged')
  finish(r2, 'Approved.')
  expect(listExchanges(db.sqlite, job())[0]).toMatchObject({ state: 'done', outcome: 'approved' })
})

test('an author sent back may ask a question first; the review keeps its round', () => {
  ask('builder', 'Build it.')
  db.sqlite.prepare("UPDATE jobs SET holder_agent_id = 'builder' WHERE id = ?").run(job())
  const b = start('builder')
  act(b, { action: 'review', to: 'reviewer', note: 'Ready.' })
  finish(b, 'Done.')
  const r = start('reviewer')
  act(r, { action: 'send_back', note: 'Fix the cursor.' })
  finish(r, 'Sent back.')
  const b2 = start('builder')
  act(b2, { action: 'ask', to: 'designer', question: 'Page size?' })
  finish(b2, 'Asking.')
  expect(listExchanges(db.sqlite, job())[0]).toMatchObject({ state: 'waiting_on_agent', round: 2 })
  finish(start('designer'), '25.')
  // The review still waits on the author, not on the reviewer.
  expect(listExchanges(db.sqlite, job())[0]).toMatchObject({ state: 'waiting_on_agent', round: 2 })
  const b3 = start('builder')
  act(b3, { action: 'review', to: 'reviewer', note: 'Fixed, 25 per page.' })
  finish(b3, 'Fixed.')
  const reviews = listExchanges(db.sqlite, job()).filter((x) => x.kind === 'review')
  expect(reviews).toHaveLength(1)
  expect(reviews[0]).toMatchObject({ state: 'live', round: 2 })
})

test('answering a question and handing work to the asker in one turn queues both turns', () => {
  ask('builder', 'Build it.')
  const b = start('builder')
  act(b, { action: 'ask', to: 'designer', question: 'Colour?' })
  finish(b, 'Asking.')
  const d = start('designer')
  act(d, { action: 'handoff', to: 'builder', note: 'Also wire the icons, please.' })
  finish(d, 'Coral.')
  const builderTurns = pending().filter((row) => row.agent_id === 'builder')
  expect(builderTurns).toHaveLength(2)
  expect(builderTurns.map((row) => row.input).join('\n')).toContain('answered your question')
  expect(builderTurns.map((row) => row.input).join('\n')).toContain('handed this work to you')
})

test('a summary run does not keep a job working', () => {
  ask('builder', 'Build it.')
  const b = start('builder')
  db.sqlite
    .prepare(
      `INSERT INTO message_runs (message_id, room_id, agent_id, chain_id, hop, turn_id, parent_message_id, input, agents,
         created_at, purpose)
       SELECT 'reply:s', room_id, 'lead', chain_id, 0, 's', parent_message_id, 'sum', '[]', created_at, 'summary'
       FROM message_runs WHERE turn_id = ?`,
    )
    .run(b.turnId)
  finish(b, 'Done.')
  expect(jobState()).toMatchObject({ state: 'waiting_on_you' })
})
