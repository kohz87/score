import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ExchangeAction, Message } from '@score/contract'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { migrate, openDatabase, type ScoreDb } from '../../src/db/index.ts'
import { stageAction, turnForCapability } from '../../src/domain/exchanges/actions.ts'
import { hashXtc, mintXtc } from '../../src/domain/exchanges/capability.ts'
import { jobRunInput } from '../../src/domain/exchanges/context.ts'
import { createJob, listExchanges } from '../../src/domain/exchanges/store.ts'
import { defaultJobId } from '../../src/domain/job-sessions.ts'
import {
  attachRunMessage,
  completeRunMessage,
  MessageRunSchema,
  reserveMessageRun,
} from '../../src/domain/message-runs.ts'
import { insertRoom, messageFromRow, storeMessage } from '../../src/domain/rooms.ts'

// PLAN 11.1b done-when (fixture tests): exchanges and agent actions in a room with routing = exchanges.

let dir: string
let db: ScoreDb
let clock = 0
const AGENTS = ['lead', 'builder', 'reviewer', 'designer']
const tick = () => new Date(Date.UTC(2026, 9, 24, 9, 0, 0, ++clock * 10)).toISOString()

beforeEach(() => {
  clock = 0
  dir = mkdtempSync(join(tmpdir(), 'score-exchanges-'))
  db = openDatabase(join(dir, 'score.db'))
  migrate(db, fileURLToPath(new URL('../../migrations/', import.meta.url)))
  for (const id of AGENTS)
    db.sqlite
      .prepare(
        "INSERT INTO agent_lifecycle (agent_id, incarnation_id, state) VALUES (?, ?, 'ready')",
      )
      .run(id, crypto.randomUUID())
  room('team', 'exchanges')
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function room(id: string, routing: 'exchanges' | 'mentions') {
  insertRoom(
    db.sqlite,
    { id, name: `#${id}`, kind: 'room', leadAgentId: 'lead', members: AGENTS },
    tick(),
  )
  db.sqlite.prepare('UPDATE rooms SET routing = ? WHERE id = ?').run(routing, id)
}

let seq = 0
/** The person writes to one agent in a job: their message and the turn it starts. */
function ask(
  agentId: string,
  text: string,
  { roomId = 'team', jobId }: { roomId?: string; jobId?: string } = {},
) {
  const id = `m${++seq}`
  const now = tick()
  storeMessage(
    db.sqlite,
    {
      id,
      roomId,
      author: { kind: 'you' },
      to: [agentId],
      parts: [{ kind: 'text', text }],
      createdAt: now,
      streaming: false,
      refs: [],
      ...(jobId ? { jobId } : {}),
    },
    now,
  )
  reserveMessageRun(
    db.sqlite,
    { parentMessageId: id, roomId, agentId, chainId: id, hop: 0, input: text, agents: AGENTS },
    now,
  )
  return id
}

interface Running {
  turnId: string
  runId: string
  agentId: string
  capability: string
}
/** Starts the oldest queued turn of `agentId` as the dispatcher would: a fresh capability, then admission. */
function start(agentId: string, runtime = 'hermes'): Running {
  const row = MessageRunSchema.parse(
    db.sqlite
      .prepare(
        "SELECT * FROM message_runs WHERE agent_id = ? AND state = 'pending' ORDER BY created_at, rowid LIMIT 1",
      )
      .get(agentId),
  )
  const capability = mintXtc()
  db.sqlite
    .prepare('UPDATE message_runs SET xtc_hash = ? WHERE turn_id = ?')
    .run(hashXtc(capability), row.turn_id)
  const runId = `run-${++seq}`
  const now = tick()
  db.sqlite
    .prepare(
      "INSERT INTO runs (id, profile, origin, status, started_at, updated_at, runtime) VALUES (?, ?, 'score', 'running', ?, ?, ?)",
    )
    .run(runId, agentId, now, now, runtime)
  attachRunMessage(db.sqlite, row.turn_id, runId, now)
  return { turnId: row.turn_id, runId, agentId, capability }
}

function act(turn: Running, action: ExchangeAction, commandId = `c${++seq}`) {
  const found = turnForCapability(db.sqlite, turn.capability, turn.agentId)
  if (!found) throw new Error('capability refused')
  return stageAction(db.sqlite, { turn: found, commandId, action, channel: 'bridge' }, tick())
}

function finish(turn: Running, output: string, status = 'completed') {
  return completeRunMessage(db.sqlite, turn.runId, tick(), { output, status, reply: output })
}

const pending = () =>
  db.sqlite
    .prepare(
      "SELECT agent_id, input, exchange_id FROM message_runs WHERE state = 'pending' ORDER BY rowid",
    )
    .all() as { agent_id: string; input: string; exchange_id: string | null }[]
const replyOf = (turn: Running): Message =>
  messageFromRow(
    db.sqlite.prepare('SELECT * FROM messages WHERE id = ?').get(`reply:${turn.turnId}`),
  )
const job = () => defaultJobId(db.sqlite, 'team')!
const jobState = () =>
  db.sqlite.prepare('SELECT state, holder_agent_id FROM jobs WHERE id = ?').get(job())

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
