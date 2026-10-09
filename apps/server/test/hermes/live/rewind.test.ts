import { mkdirSync } from 'node:fs'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { RewindBroker } from '../../../src/hermes/bridge/rewind-broker.ts'
import { inspectSession, rewindSession } from '../../../src/hermes/live/rewind.ts'
import { createFixtureHome } from '../../fixtures/hermes/sqlite-fixture.ts'

let hermes: ReturnType<typeof createFixtureHome>
beforeEach(() => {
  hermes = createFixtureHome()
})
afterEach(() => hermes.close())

const SESSION = 'score-chat-builder'
type Row = [role: string, at: number, extra?: { active?: number; displayKind?: string }]

function write(rows: Row[], child?: { id: string; startedAt: number; rows: Row[] }) {
  mkdirSync(`${hermes.home}/profiles/builder`, { recursive: true })
  const { db } = hermes.build('state', 'profiles/builder/state.db')
  db.prepare(
    `INSERT INTO sessions (id, source, profile_name, model, started_at) VALUES (?, 'api_server', 'builder', 'm', 1)`,
  ).run(SESSION)
  const insert = db.prepare(
    'INSERT INTO messages (session_id, role, content, timestamp, active, display_kind) VALUES (?, ?, ?, ?, ?, ?)',
  )
  for (const [role, at, extra] of rows)
    insert.run(SESSION, role, 'x', at, extra?.active ?? 1, extra?.displayKind ?? null)
  if (child) {
    db.prepare("UPDATE sessions SET end_reason = 'compression' WHERE id = ?").run(SESSION)
    db.prepare(
      `INSERT INTO sessions (id, source, profile_name, model, started_at, parent_session_id) VALUES (?, 'api_server', 'builder', 'm', ?, ?)`,
    ).run(child.id, child.startedAt, SESSION)
    for (const [role, at] of child.rows) insert.run(child.id, role, 'x', at, 1, null)
  }
}
const inspect = (sinceSeconds: number, sessionId = SESSION) =>
  inspectSession({ profile: 'builder', sessionId, sinceSeconds }, hermes.home)

test('counts the active user turns from the message on, ignoring display rows and rewound rows', () => {
  write([
    ['user', 10],
    ['assistant', 11],
    ['user', 20],
    ['assistant', 21],
    ['user', 22, { displayKind: 'hidden' }],
    ['user', 30],
    ['assistant', 31],
    ['user', 40, { active: 0 }],
  ])
  expect(inspect(15)).toEqual({ ok: true, sessionId: SESSION, turns: 2, undone: 1 })
  expect(inspect(5)).toEqual({ ok: true, sessionId: SESSION, turns: 3, undone: 1 })
  expect(inspect(100)).toEqual({ ok: true, sessionId: SESSION, turns: 0, undone: 0 })
})

test('follows a compression that happened before the message and refuses one after it', () => {
  write(
    [
      ['user', 10],
      ['assistant', 11],
    ],
    {
      id: 'score-chat-builder-2',
      startedAt: 50,
      rows: [
        ['user', 60],
        ['assistant', 61],
        ['user', 70],
      ],
    },
  )
  // The message came after the compression: its turns are in the continuation.
  expect(inspect(55)).toEqual({ ok: true, sessionId: 'score-chat-builder-2', turns: 2, undone: 0 })
  // The message came before it: its turns are split over two sessions.
  expect(inspect(5)).toEqual({ ok: false, reason: 'compressed' })
})

test('an unknown session or missing history has no session', () => {
  expect(inspect(5)).toEqual({ ok: false, reason: 'no_session' })
  write([['user', 10]])
  expect(inspect(5, 'score-other-builder')).toEqual({ ok: false, reason: 'no_session' })
})

test('rewinding checks Hermes first, then asks the bridge and reports its answer', async () => {
  write([
    ['user', 10],
    ['user', 20],
  ])
  const broker = new RewindBroker()
  const req = { agentId: 'builder', sessionId: SESSION, turns: 2, sinceMs: 5000 }
  const deps = { broker, hermesHome: hermes.home }
  expect(await rewindSession(req, deps)).toEqual({
    status: 'skipped',
    reason: 'bridge_unavailable',
  })
  expect(await rewindSession({ ...req, turns: 1 }, deps)).toEqual({
    status: 'skipped',
    reason: 'turn_count_mismatch',
  })
  // The bridge listens: a dry run is ready, a real one waits for the plugin.
  const listening = broker.claim('builder', 10, new AbortController().signal)
  await listening
  expect(await rewindSession({ ...req, dryRun: true }, deps)).toEqual({ status: 'ready' })
  const running = rewindSession(req, deps)
  const [command] = await broker.claim('builder', 1000, new AbortController().signal)
  expect(command).toMatchObject({ sessionId: SESSION, turns: 2, since: 5 })
  broker.complete('builder', command!.commandId, {
    outcome: 'done',
    turnsUndone: 2,
    rewoundCount: 4,
  })
  expect(await running).toEqual({ status: 'rewound', turnsUndone: 2, rewoundCount: 4 })
})

// audit4-c 7: Hermes finished a rewind whose answer Score never recorded.
test('a session already rewound since the message counts as rewound, not as a mismatch', async () => {
  write([
    ['user', 10],
    ['assistant', 11],
    ['user', 20, { active: 0 }],
    ['assistant', 21, { active: 0 }],
  ])
  const req = { agentId: 'builder', sessionId: SESSION, turns: 1, sinceMs: 15000 }
  const deps = { broker: undefined, hermesHome: hermes.home }
  expect(await rewindSession({ ...req, dryRun: true }, deps)).toEqual({ status: 'ready' })
  expect(await rewindSession(req, deps)).toEqual({
    status: 'rewound',
    turnsUndone: 0,
    rewoundCount: 0,
  })
  // A session with no undone rows and a different count is still a mismatch.
  expect(await rewindSession({ ...req, turns: 3, sinceMs: 5000 }, deps)).toEqual({
    status: 'skipped',
    reason: 'turn_count_mismatch',
  })
})
