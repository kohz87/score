import { MessageSchema, type Message } from '@score/contract'
import { expect, test } from 'vitest'
import { reserveMessageRun } from '../../src/domain/message-runs.ts'
import { storeMessage } from '../../src/domain/rooms.ts'

import { createRoutingHelpers, routingTestSuite, type RoutingTestState } from './routing-helpers.ts'

let dir: RoutingTestState['dir']
let db: RoutingTestState['db']
let ingest: RoutingTestState['ingest']
let port: RoutingTestState['port']
let scheduler: RoutingTestState['scheduler']
let app: RoutingTestState['app']
let headers: RoutingTestState['headers']
let roomId: RoutingTestState['roomId']
let replies: RoutingTestState['replies']
const current = (): RoutingTestState => ({
  dir,
  db,
  ingest,
  port,
  scheduler,
  app,
  headers,
  roomId,
  replies,
})
routingTestSuite((next) => {
  dir = next.dir
  db = next.db
  ingest = next.ingest
  port = next.port
  scheduler = next.scheduler
  app = next.app
  headers = next.headers
  roomId = next.roomId
  replies = next.replies
}, current)

const { post, send, messages, events, advance } = createRoutingHelpers(current)

test('Stop ends the run writing a streaming reply and the reply says it was stopped (PLAN 5.25)', async () => {
  replies.lead = 'Working through the details. '.repeat(40)
  await send({ text: 'long reply please' })
  await advance(600)
  const writing = messages().find((message) => message.author.kind === 'agent')!
  expect(writing.streaming).toBe(true)
  const stopped = await post(`/api/rooms/${roomId}/messages/${writing.id}/stop`, {})
  expect(stopped.statusCode).toBe(200)
  expect(stopped.json()).toEqual({ ok: true })
  await advance(1000)
  const done = MessageSchema.parse(messages().find((message) => message.id === writing.id))
  expect(done.streaming).toBe(false)
  expect(done.parts.some((part) => part.kind === 'text' && part.text.includes('was stopped'))).toBe(
    true,
  )
  // Finished replies and unknown messages are refused.
  expect((await post(`/api/rooms/${roomId}/messages/${writing.id}/stop`, {})).statusCode).toBe(409)
  expect((await post(`/api/rooms/${roomId}/messages/nope/stop`, {})).statusCode).toBe(404)
})

test('the agent context reports the latest usage with the model window, null when unknown (PLAN 5.25)', async () => {
  const empty = await app.inject({ url: '/api/agents/lead/context' })
  expect(empty.statusCode).toBe(200)
  expect(empty.json()).toMatchObject({ tokens: null, costUsd: null })
  expect((await app.inject({ url: '/api/agents/nobody/context' })).statusCode).toBe(404)
  await send({ text: 'hello' })
  await advance(4000)
  const used = (await app.inject({ url: '/api/agents/lead/context' })).json()
  expect(used).toEqual({
    model: 'fake-model',
    tokens: { input: 1200, output: 240 },
    costUsd: 0.0042,
    contextLength: 128000,
  })
})

test('a reply cancelled while Hermes admits it does not stream into the room and the run is stopped', async () => {
  await ingest.submit({
    source: 'test',
    identity: 'parent-1',
    apply({ sqlite, now }) {
      const message: Message = {
        id: 'parent-1',
        roomId,
        author: { kind: 'you' },
        to: [],
        parts: [{ kind: 'text', text: 'hello' }],
        refs: [],
        streaming: false,
        createdAt: now,
      }
      return storeMessage(sqlite, message, now)
    },
  })
  const reserved = db.tx((sqlite) =>
    reserveMessageRun(
      sqlite,
      {
        parentMessageId: 'parent-1',
        roomId,
        agentId: 'builder',
        chainId: 'parent-1',
        hop: 0,
        input: 'hello',
        agents: ['builder'],
      },
      new Date(scheduler.now()).toISOString(),
    ),
  )
  const turnId = reserved.replace(/^reply:/, '')
  // The delete/edit path marks the pending run failed before Hermes answers.
  db.sqlite.prepare("UPDATE message_runs SET state = 'failed' WHERE turn_id = ?").run(turnId)
  const { runId } = await port.startRun({ agentId: 'builder', input: 'hello', turnId })
  await ingest.flushListeners()
  await ingest.drain()
  const row = db.sqlite
    .prepare('SELECT run_id, state FROM message_runs WHERE turn_id = ?')
    .get(turnId)
  expect(row).toMatchObject({ run_id: null, state: 'failed' })
  expect(db.sqlite.prepare('SELECT 1 FROM messages WHERE id = ?').get(reserved)).toBeUndefined()
  expect(db.sqlite.prepare('SELECT status FROM runs WHERE id = ?').get(runId)).toMatchObject({
    status: 'cancelled',
  })
})

test('3.10.0: a finished reply carries the speed of its run; a streaming one carries none', async () => {
  replies.lead = 'A short answer that streams in a few pieces. '.repeat(3)
  await send({ text: 'hello' })
  await advance(600)
  const writing = messages().find((message) => message.author.kind === 'agent')!
  expect(writing.streaming).toBe(true)
  expect(writing.speed).toBeUndefined()
  await advance(5000)
  const done = messages().find((message) => message.id === writing.id)!
  expect(done.streaming).toBe(false)
  expect(done.speed).toMatchObject({ outputTokens: 240 })
  expect(done.speed?.ttftMs).toBeGreaterThanOrEqual(0)
  const completed = events().find((event) => event.type === 'message.completed')
  expect(completed?.data).toMatchObject({ speed: { outputTokens: 240 } })
})
