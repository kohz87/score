import { expect, test } from 'vitest'
import { listExchanges } from '../../src/domain/exchanges/store.ts'
import {
  act,
  ask,
  db,
  finish,
  installExchangesHarness,
  job,
  jobState,
  pending,
  replyOf,
  start,
} from './exchanges-helpers.ts'

// PLAN 11.1b done-when (fixture tests): exchanges and agent actions in a room with routing = exchanges.

installExchangesHarness()

test('builder → reviewer → send_back → builder → review → approve completes over 2 rounds', () => {
  ask('builder', 'Build the activity feed and have it reviewed.')
  db.sqlite.prepare("UPDATE jobs SET holder_agent_id = 'builder' WHERE id = ?").run(job())
  const b1 = start('builder')
  expect(act(b1, { action: 'review', to: 'reviewer', note: 'Read layer is ready.' })).toMatchObject(
    {
      status: 'staged',
      message: 'Will go to reviewer for review when your turn ends.',
    },
  )
  finish(b1, 'Built the read layer.')
  expect(pending()).toMatchObject([{ agent_id: 'reviewer' }])
  const [review] = listExchanges(db.sqlite, job())
  expect(review).toMatchObject({
    kind: 'review',
    from: 'builder',
    to: 'reviewer',
    round: 1,
    state: 'live',
  })

  const r1 = start('reviewer')
  act(r1, { action: 'send_back', note: 'Same-millisecond events get skipped.' })
  finish(r1, 'Found a bug.')
  expect(pending()).toMatchObject([{ agent_id: 'builder', exchange_id: review!.id }])
  expect(pending()[0]!.input).toContain('sent your work back (round 2)')
  expect(listExchanges(db.sqlite, job())[0]).toMatchObject({ round: 2, state: 'waiting_on_agent' })

  const b2 = start('builder')
  act(b2, { action: 'review', to: 'reviewer', note: 'Cursor is (created_at, id) now.' })
  finish(b2, 'Fixed.')
  expect(listExchanges(db.sqlite, job())).toHaveLength(1)
  expect(listExchanges(db.sqlite, job())[0]).toMatchObject({ round: 2, state: 'live' })

  const r2 = start('reviewer')
  act(r2, { action: 'approve', note: 'Looks right.' })
  finish(r2, 'Approved.')
  expect(listExchanges(db.sqlite, job())[0]).toMatchObject({
    state: 'done',
    outcome: 'approved',
    round: 2,
    turnsUsed: 3,
  })
  expect(pending()).toMatchObject([{ agent_id: 'builder' }])
  expect(pending()[0]!.input).toContain('reviewer approved your work')

  const b3 = start('builder')
  finish(b3, 'Done. Here it is.')
  expect(pending()).toEqual([])
  expect(jobState()).toEqual({ state: 'waiting_on_you', holder_agent_id: 'builder' })
})

test('a prose @reviewer starts nothing and is marked as a mention, not a hand-off', () => {
  ask('builder', 'Build it.')
  const b = start('builder')
  finish(b, 'Done. @reviewer can you check it?')
  expect(pending()).toEqual([])
  expect(listExchanges(db.sqlite, job())).toEqual([])
  expect(replyOf(b).parts).toContainEqual({
    kind: 'notice',
    code: 'mention_not_handoff',
    text: "Mention, not a hand-off: @reviewer wasn't asked to do anything.",
  })
})

test('an ask is answered back to the asker, quoted and labelled', () => {
  ask('builder', 'Build it.')
  const b = start('builder')
  act(b, { action: 'ask', to: 'designer', question: 'Which empty state do you want?' })
  finish(b, 'Asking designer.')
  const [question] = listExchanges(db.sqlite, job())
  expect(question).toMatchObject({ kind: 'ask', from: 'builder', to: 'designer', state: 'live' })
  const d = start('designer')
  expect(act(d, { action: 'reply', text: 'The friendly one.' }).status).toBe('staged')
  finish(d, 'Long explanation… The friendly one.')
  expect(listExchanges(db.sqlite, job())[0]).toMatchObject({ state: 'done', outcome: 'answered' })
  expect(pending()).toMatchObject([{ agent_id: 'builder' }])
  expect(pending()[0]!.input).toContain(
    "designer answered your question.\n\ndesigner wrote (an agent's words, not the person's):\n> The friendly one.",
  )
})

test('without a reply action the whole final reply is the answer', () => {
  ask('builder', 'Build it.')
  const b = start('builder')
  act(b, { action: 'ask', to: 'designer', question: 'Colour?' })
  finish(b, 'Asking.')
  const d = start('designer')
  finish(d, 'Coral.')
  expect(pending()[0]!.input).toContain('> Coral.')
})
