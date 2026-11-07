import { expect, test } from 'vitest'
import { turnForCapability } from '../../src/domain/exchanges/actions.ts'
import { mintXtc } from '../../src/domain/exchanges/capability.ts'
import { jobRunInput } from '../../src/domain/exchanges/context.ts'
import { createJob, listExchanges } from '../../src/domain/exchanges/store.ts'
import { MessageRunSchema } from '../../src/domain/message-runs.ts'
import {
  act,
  ask,
  db,
  finish,
  installExchangesHarness,
  job,
  pending,
  replyOf,
  room,
  start,
  tick,
} from './exchanges-helpers.ts'

installExchangesHarness()

test('a failed or stopped turn applies none of its staged actions and says so', () => {
  for (const status of ['failed', 'cancelled']) {
    ask('builder', 'Build it.')
    const b = start('builder')
    act(b, { action: 'handoff', to: 'designer', note: 'Your turn.' })
    finish(b, 'Partial', status)
    expect(pending()).toEqual([])
    expect(listExchanges(db.sqlite, job())).toEqual([])
    expect(replyOf(b).parts).toContainEqual({
      kind: 'notice',
      code: 'action_not_sent',
      text: `builder's hand-off to designer was not sent: the turn ${status === 'failed' ? 'failed' : 'was stopped'}.`,
    })
    expect(
      db.sqlite.prepare('SELECT state FROM exchange_actions WHERE turn_id = ?').get(b.turnId),
    ).toEqual({ state: 'dropped' })
  }
})

test('a second routing action in one turn is refused unless it replaces the first', () => {
  ask('builder', 'Build it.')
  db.sqlite.prepare("UPDATE jobs SET holder_agent_id = 'builder' WHERE id = ?").run(job())
  const b = start('builder')
  expect(act(b, { action: 'handoff', to: 'designer', note: 'Draw it.' }, 'first').status).toBe(
    'staged',
  )
  expect(act(b, { action: 'review', to: 'reviewer', note: 'Check it.' }, 'second')).toMatchObject({
    status: 'refused',
    code: 'action_limit',
  })
  // The same commandId again answers the same.
  expect(act(b, { action: 'review', to: 'reviewer', note: 'Check it.' }, 'second').code).toBe(
    'action_limit',
  )
  expect(
    act(b, { action: 'review', to: 'reviewer', note: 'Check it.', replaces: 'first' }, 'third')
      .status,
  ).toBe('staged')
  finish(b, 'Done.')
  expect(pending()).toMatchObject([{ agent_id: 'reviewer' }])
})

test('a capability from another turn, an ended turn or in the text is refused', () => {
  ask('builder', 'Build it.')
  ask('reviewer', 'Look around.')
  const b = start('builder')
  const r = start('reviewer')
  // Another agent's turn: the producer's profile must be the turn's agent.
  expect(turnForCapability(db.sqlite, r.capability, 'builder')).toBeNull()
  expect(turnForCapability(db.sqlite, mintXtc(), 'builder')).toBeNull()
  expect(act(b, { action: 'handoff', to: 'designer', note: `use ${r.capability}` })).toMatchObject({
    status: 'refused',
    code: 'capability_in_text',
  })
  expect(db.sqlite.prepare('SELECT count(*) AS n FROM exchange_actions').get()).toEqual({ n: 0 })
  finish(b, 'Done.')
  // Ended: the capability went with the turn.
  expect(turnForCapability(db.sqlite, b.capability, 'builder')).toBeNull()
  expect(
    db.sqlite.prepare('SELECT xtc_hash FROM message_runs WHERE turn_id = ?').get(b.turnId),
  ).toEqual({ xtc_hash: null })
})

test('actions are checked at once: members only, not to oneself, verdicts only for the reviewer', () => {
  ask('builder', 'Build it.')
  const b = start('builder')
  expect(act(b, { action: 'handoff', to: 'builder', note: 'x' }).code).toBe('self')
  expect(act(b, { action: 'handoff', to: 'stranger', note: 'x' }).code).toBe('not_member')
  expect(act(b, { action: 'approve', note: 'x' }).code).toBe('not_allowed')
  expect(act(b, { action: 'reply', text: 'x' }).code).toBe('not_allowed')
  // Only the holder of the work asks for a review.
  expect(act(b, { action: 'review', to: 'reviewer', note: 'x' }).code).toBe('not_allowed')
})

test("a coding agent's single score-action block routes; two blocks route nothing and say why", () => {
  ask('builder', 'Build it.')
  const one = start('builder', 'claude-code')
  finish(
    one,
    'Done.\n```score-action\n{"action":"handoff","to":"designer","note":"Draw the empty state."}\n```',
  )
  expect(pending()).toMatchObject([{ agent_id: 'designer' }])
  expect(listExchanges(db.sqlite, job())).toMatchObject([
    { kind: 'handoff', from: 'builder', to: 'designer' },
  ])

  ask('builder', 'Again.')
  const two = start('builder', 'claude-code')
  const block = '```score-action\n{"action":"handoff","to":"designer","note":"x"}\n```'
  finish(two, `${block}\n${block}`)
  expect(pending()).toHaveLength(1)
  expect(replyOf(two).parts).toContainEqual({
    kind: 'notice',
    code: 'action_ignored',
    text: "Score ignored this reply's action: it had 2 score-action blocks.",
  })
})

test('context holds only this job’s messages since the agent’s last turn (snapshot)', () => {
  const other = db.tx((sqlite) => createJob(sqlite, 'team', 'Release notes', tick())).job
  ask('builder', 'Build the feed.')
  const b1 = start('builder')
  finish(b1, 'Built the read layer.')
  ask('reviewer', 'Is the read layer fine?')
  finish(start('reviewer'), 'Looks fine to me.')
  ask('reviewer', 'Draft release notes.', { jobId: other.id })
  finish(start('reviewer'), 'Notes drafted for 2.4.')
  ask('builder', 'Now switch it to websockets.')
  const turn = MessageRunSchema.parse(
    db.sqlite
      .prepare("SELECT * FROM message_runs WHERE state = 'pending' AND agent_id = 'builder'")
      .get(),
  )
  const capability = '{{SCORE_EXCHANGE_CAPABILITY}}'
  const input = jobRunInput(db.sqlite, turn, { coding: false })
  expect(input).not.toContain('release notes')
  expect(input).not.toContain('Notes drafted')
  expect(input).not.toContain('Build the feed.')
  expect(input).not.toContain('Built the read layer.')
  expect(input).toContain('you: Is the read layer fine?\nreviewer: Looks fine to me.')
  expect(input).toContain(capability)
  expect(input).toMatchSnapshot()
})

test('older rooms still route by @mention', () => {
  room('older', 'mentions')
  ask('builder', 'Build it.', { roomId: 'older' })
  const b = start('builder')
  finish(b, 'Done. @reviewer please check.')
  expect(pending()).toMatchObject([{ agent_id: 'reviewer' }])
  expect(db.sqlite.prepare('SELECT count(*) AS n FROM exchanges').get()).toEqual({ n: 0 })
})
