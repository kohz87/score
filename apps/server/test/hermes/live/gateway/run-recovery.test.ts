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

function writeHistory(rows: Row[]) {
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
}

async function admittedMessage() {
  await env.ingest.submit({
    source: 'test',
    identity: 'room-message',
    apply({ sqlite, now }) {
      insertRoom(
        sqlite,
        { id: 'chat', name: '#chat', kind: 'room', leadAgentId: 'builder', members: ['builder'] },
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
