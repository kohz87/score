import { mkdirSync, rmSync } from 'node:fs'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { reserveMessageRun } from '../../../../src/domain/message-runs.ts'
import { insertRoom, messageFromRow, storeMessage } from '../../../../src/domain/rooms.ts'
import { messageTurnId } from '../../../../src/domain/routing.ts'
import { recoverRunOutput } from '../../../../src/hermes/live/recover.ts'
import { followRun } from '../../../../src/hermes/live/runs.ts'
import { readRun } from '../../../../src/hermes/live/translate.ts'
import { createFixtureHome } from '../../../fixtures/hermes/sqlite-fixture.ts'
import { setup } from './helpers.ts'

let env: ReturnType<typeof setup>
let hermes: ReturnType<typeof createFixtureHome>
beforeEach(() => {
  env = setup()
  hermes = createFixtureHome()
})
afterEach(async () => {
  await env.ingest.close()
  env.db.close()
  hermes.close()
  rmSync(env.home, { recursive: true, force: true })
})

const SESSION = 'score-chat-builder'
type Row = [role: string, content: string | null, at: number, toolCalls?: string]

function writeHistory(rows: Row[], compressedInto?: { id: string; rows: Row[] }) {
  mkdirSync(`${hermes.home}/profiles/builder`, { recursive: true })
  const { db } = hermes.build('state', 'profiles/builder/state.db')
  db.prepare(
    `INSERT INTO sessions (id, source, profile_name, model, started_at)
     VALUES (?, 'api_server', 'builder', 'example-model', 1)`,
  ).run(SESSION)
  for (const [role, content, at, toolCalls] of rows)
    db.prepare(
      'INSERT INTO messages (session_id, role, content, tool_calls, timestamp) VALUES (?, ?, ?, ?, ?)',
    ).run(SESSION, role, content, toolCalls ?? null, at)
  if (compressedInto) {
    db.prepare("UPDATE sessions SET end_reason = 'compression' WHERE id = ?").run(SESSION)
    db.prepare(
      `INSERT INTO sessions (id, source, profile_name, model, started_at, parent_session_id)
       VALUES (?, 'api_server', 'builder', 'example-model', 1, ?)`,
    ).run(compressedInto.id, SESSION)
    for (const [role, content, at] of compressedInto.rows)
      db.prepare(
        'INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)',
      ).run(compressedInto.id, role, content, at)
  }
}

async function admittedMessage() {
  await env.ingest.submit({
    source: 'test',
    identity: 'room-message',
    apply({ sqlite, now }) {
      insertRoom(
        sqlite,
        {
          id: 'chat',
          name: '#chat',
          kind: 'room',
          leadAgentId: 'builder',
          members: ['builder'],
          routing: 'mentions', // D3.2 @mention routing, kept for rooms still on mentions (orchestration runs)
        },
        now,
      )
      const drafts = storeMessage(
        sqlite,
        {
          id: 'human',
          roomId: 'chat',
          author: { kind: 'you' },
          to: [],
          parts: [{ kind: 'text', text: 'fixture' }],
          refs: [],
          streaming: false,
          createdAt: now,
        },
        now,
      )
      reserveMessageRun(
        sqlite,
        {
          parentMessageId: 'human',
          roomId: 'chat',
          agentId: 'builder',
          chainId: 'human',
          hop: 0,
          input: 'fixture',
          agents: ['builder', 'reviewer'],
        },
        now,
      )
      return drafts
    },
  })
  const { runId } = await env.intents.startRunIntent(
    { profile: 'builder', input: 'fixture' },
    messageTurnId('human', 'builder'),
  )
  // Hermes forgot the run.
  env.fake.runs.delete(`builder:${runId}`)
  return { profile: 'builder', runId, credentialGeneration: 1 }
}

async function follow(context: Awaited<ReturnType<typeof admittedMessage>>) {
  await followRun({
    db: env.db,
    gateway: env.gateway,
    sink: env.ingest,
    context,
    metrics: { unknownEvents: 0 },
    pollIntervalMs: 0,
    recoverOutput: (request) => recoverRunOutput(request, hermes.home),
  })
}
const reply = () =>
  messageFromRow(env.db.sqlite.prepare("SELECT * FROM messages WHERE author_kind = 'agent'").get())

test('a forgotten run completes its reply from the session history, with hand-offs and a recovered note', async () => {
  const context = await admittedMessage()
  const startedSec = Date.parse(readRun(env.db.sqlite, context.runId).started_at) / 1000
  writeHistory([
    ['user', 'older question', startedSec - 100],
    ['assistant', 'older answer', startedSec - 90],
    ['user', 'fixture', startedSec + 1],
    ['assistant', null, startedSec + 2, '[{"id":"c1"}]'],
    ['tool', 'ok', startedSec + 3],
    [
      'assistant',
      'All done. @reviewer please check. token=sk-abcdefghijklmnopqrstuvwx',
      startedSec + 4,
    ],
  ])
  await follow(context)
  const run = readRun(env.db.sqlite, context.runId)
  expect(run).toMatchObject({ status: 'completed', error: null })
  expect(run.output).toContain('All done. @reviewer please check.')
  expect(run.output).not.toContain('sk-abcdefghijklmnopqrstuvwx')
  const text = JSON.stringify(reply().parts)
  expect(text).toContain('All done.')
  expect(text).not.toContain('older answer')
  expect(text).not.toContain('sk-abcdefghijklmnopqrstuvwx')
  expect(
    env.db.sqlite.prepare('SELECT reason FROM gaps WHERE run_id = ?').get(context.runId)?.reason,
  ).toContain('recovered')
  expect(
    env.db.sqlite
      .prepare("SELECT agent_id, hop FROM message_runs WHERE agent_id = 'reviewer'")
      .get(),
  ).toMatchObject({ agent_id: 'reviewer', hop: 1 })
})

test.each([
  ['no history file', null],
  [
    'only an earlier turn',
    [
      ['user', 'q', 1],
      ['assistant', 'old', 2],
    ] as Row[],
  ],
  [
    'turn still working (ends in a tool step)',
    (s: number): Row[] => [
      ['user', 'fixture', s + 1],
      ['assistant', 'thinking', s + 2, '[{"id":"c1"}]'],
    ],
  ],
])('%s leaves the run interrupted as before', async (_name, history) => {
  const context = await admittedMessage()
  const startedSec = Date.parse(readRun(env.db.sqlite, context.runId).started_at) / 1000
  if (history) writeHistory(typeof history === 'function' ? history(startedSec) : history)
  await follow(context)
  expect(readRun(env.db.sqlite, context.runId)).toMatchObject({
    status: 'interrupted',
    error: 'Hermes no longer has a record of this run',
  })
  expect(JSON.stringify(reply().parts)).toContain('interrupted')
})

test("a later turn in the same session is not recovered as this run's answer", async () => {
  const context = await admittedMessage()
  const s = Date.parse(readRun(env.db.sqlite, context.runId).started_at) / 1000
  writeHistory([
    ['user', 'fixture', s + 1],
    ['assistant', null, s + 2, '[{"id":"c1"}]'],
    ['user', 'resumed by the owner', s + 500],
    ['assistant', 'Unrelated. @reviewer do things', s + 501],
  ])
  await follow(context)
  expect(readRun(env.db.sqlite, context.runId).status).toBe('interrupted')
  expect(
    env.db.sqlite
      .prepare("SELECT count(*) AS n FROM message_runs WHERE agent_id = 'reviewer'")
      .get(),
  ).toMatchObject({ n: 0 })
})

test('an answer written after compression moved the session is recovered from the continuation', async () => {
  const context = await admittedMessage()
  const s = Date.parse(readRun(env.db.sqlite, context.runId).started_at) / 1000
  writeHistory([['user', 'fixture', s + 1]], {
    id: 'score-chat-builder-2',
    rows: [['assistant', 'Finished after compression.', s + 9]],
  })
  await follow(context)
  expect(readRun(env.db.sqlite, context.runId)).toMatchObject({ status: 'completed' })
  expect(JSON.stringify(reply().parts)).toContain('Finished after compression.')
})

test('a run row rebuilt from an accepted admission keeps the original send time', async () => {
  const context = await admittedMessage()
  const sentAt = '2026-10-06T10:00:00.000Z'
  env.db.sqlite.prepare('UPDATE command_intents SET first_sent_at = ?').run(sentAt)
  env.db.sqlite.exec('PRAGMA foreign_keys = OFF')
  env.db.sqlite.prepare('DELETE FROM runs WHERE id = ?').run(context.runId)
  env.db.sqlite.exec('PRAGMA foreign_keys = ON')
  // A crash before the runs insert also means the observation was never recorded.
  env.db.sqlite.exec("DELETE FROM ingest_keys WHERE identity LIKE 'admitted:%'")
  await env.intents.startRunIntent(
    { profile: 'builder', input: 'fixture' },
    messageTurnId('human', 'builder'),
  )
  expect(readRun(env.db.sqlite, context.runId).started_at).toBe(sentAt)
})

test("a later turn is not recovered when Hermes never stored this run's user message (gate 2026-10-09)", async () => {
  const context = await admittedMessage()
  const startedSec = Date.parse(readRun(env.db.sqlite, context.runId).started_at) / 1000
  // Hermes admitted the run and shut down before persisting "fixture"; the owner later resumed the session by hand.
  writeHistory([
    ['user', 'a question typed in Hermes later', startedSec + 30],
    ['assistant', 'Here you go. @reviewer please check.', startedSec + 31],
  ])
  await follow(context)
  const run = readRun(env.db.sqlite, context.runId)
  expect(run.status).toBe('interrupted')
  expect(run.output ?? '').not.toContain('Here you go')
  expect(JSON.stringify(reply().parts)).not.toContain('Here you go')
  expect(
    env.db.sqlite
      .prepare("SELECT COUNT(*) AS n FROM message_runs WHERE agent_id = 'reviewer'")
      .get(),
  ).toEqual({ n: 0 })
})

test('a run sent with images is recovered from the text Hermes stores for it (gate re-check)', async () => {
  const context = await admittedMessage()
  const startedSec = Date.parse(readRun(env.db.sqlite, context.runId).started_at) / 1000
  writeHistory([
    [
      'user',
      'fixture\n\n(1 attached image could not be sent: too large)\n[screenshot]\n[screenshot]',
      startedSec + 1,
    ],
    ['assistant', 'Looked at both.', startedSec + 2],
  ])
  await follow(context)
  expect(readRun(env.db.sqlite, context.runId)).toMatchObject({ status: 'completed' })
  expect(JSON.stringify(reply().parts)).toContain('Looked at both.')
})

test('a later turn that repeats the same words is not recovered as this run (gate re-check)', async () => {
  const context = await admittedMessage()
  const startedSec = Date.parse(readRun(env.db.sqlite, context.runId).started_at) / 1000
  writeHistory([
    ['user', 'fixture', startedSec + 600],
    ['assistant', 'Again. @reviewer please check.', startedSec + 601],
  ])
  await follow(context)
  expect(readRun(env.db.sqlite, context.runId).status).toBe('interrupted')
  expect(JSON.stringify(reply().parts)).not.toContain('Again.')
  expect(
    env.db.sqlite
      .prepare("SELECT COUNT(*) AS n FROM message_runs WHERE agent_id = 'reviewer'")
      .get(),
  ).toEqual({ n: 0 })
})
