import { HttpError } from '../../src/errors.ts'
import { MessageSchema, RoomSchema, StreamEventSchema, type Message } from '@score/contract'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { buildApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { migrate, openDatabase, type ScoreDb } from '../../src/db/index.ts'
import { FakePort } from '../../src/hermes/fake/fake-port.ts'
import { createIngest, type Ingest } from '../../src/hub/ingest.ts'
import { FakeScheduler } from '../hermes/fake-scheduler.ts'
import { messageFromRow, storeMessage } from '../../src/domain/rooms.ts'
import { RoutingDispatcher } from '../../src/domain/routing-dispatch.ts'

let dir: string
let db: ScoreDb
let ingest: Ingest
let port: FakePort
let scheduler: FakeScheduler
let app: ReturnType<typeof buildApp>
let headers: { 'x-score-client': string; cookie: string }
let roomId: string
let replies: Record<string, string>

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'score-routing-'))
  db = openDatabase(join(dir, 'score.db'))
  migrate(db, fileURLToPath(new URL('../../migrations/', import.meta.url)))
  scheduler = new FakeScheduler()
  const clock = () => scheduler.now()
  ingest = createIngest(db, { clock })
  replies = {}
  port = new FakePort(1, { db, scheduler }, false, (req) => ({
    text: replies[req.agentId] ?? 'The streamed reply is ready.',
    tools: ['terminal', 'terminal', 'terminal', 'edit_file', 'edit_file'],
  }))
  await port.start(ingest)
  app = buildApp({
    config: loadConfig({ SCORE_MODE: 'fake' }),
    logger: false,
    db,
    ingest,
    port,
    clock,
  })
  const paired = await app.inject({
    method: 'POST',
    url: '/api/session/pair',
    headers: { 'x-score-client': 'web' },
    payload: { token: app.pairing.createToken() },
  })
  headers = {
    'x-score-client': 'web',
    cookie: paired.headers['set-cookie']!.toString().split(';')[0]!,
  }
  const created = await post('/api/rooms', { name: 'routing', leadAgentId: 'lead' })
  roomId = RoomSchema.parse(created.json()).id
})
afterEach(async () => {
  await port.stop()
  await app.close()
  await ingest.close()
  db.close()
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})
const post = (url: string, payload: object, key?: string) =>
  app.inject({
    method: 'POST',
    url,
    headers: { ...headers, ...(key ? { 'idempotency-key': key } : {}) },
    payload,
  })
const send = (payload: object, key?: string) => post(`/api/rooms/${roomId}/messages`, payload, key)
const messages = (): Message[] =>
  db.read((sqlite) =>
    sqlite.prepare('SELECT * FROM messages WHERE room_id = ?').all(roomId).map(messageFromRow),
  )
const events = () =>
  db.sqlite
    .prepare('SELECT * FROM events ORDER BY seq')
    .all()
    .map((row) =>
      StreamEventSchema.parse({ ...row, data: JSON.parse(String(row.data)) as unknown }),
    )
async function advance(ms: number) {
  await scheduler.advance(ms)
  await ingest.flushListeners()
  await ingest.drain()
}

test.each([
  [{ text: 'hello' }, ['lead']],
  [{ text: '@builder then @reviewer' }, ['builder', 'reviewer']],
  [
    { text: '@builder @reviewer', to: ['designer', 'builder'] },
    ['designer', 'builder', 'reviewer'],
  ],
])('human routing starts exactly the chosen targets: %j', async (body, targets) => {
  const run = vi.spyOn(port, 'startRun')
  const response = await send(body)
  expect(response.statusCode).toBe(200)
  expect(response.json().routedTo).toEqual(targets)
  expect(run.mock.calls.map(([req]) => req.agentId)).toEqual(targets)
  expect(messages().filter((message) => message.author.kind === 'agent')).toHaveLength(
    targets.length,
  )
})

test('direct room defaults to its agent and a leadless room rejects without storing a message', async () => {
  const list = (await app.inject({ url: '/api/rooms' })).json()
  const direct = list.directs.find(
    (room: { leadAgentId: string }) => room.leadAgentId === 'builder',
  )
  expect(
    (await post(`/api/rooms/${direct.id}/messages`, { text: 'hello' })).json().routedTo,
  ).toEqual(['builder'])
  const room = RoomSchema.parse((await post('/api/rooms', { name: 'leadless' })).json())
  const response = await post(`/api/rooms/${room.id}/messages`, { text: 'hello' })
  expect(response.statusCode).toBe(400)
  expect(response.json().error.code).toBe('no_recipient')
  expect((await app.inject({ url: `/api/rooms/${room.id}/messages` })).json().items).toEqual([])
})

test('assign creates one task and receipt replay never reroutes', async () => {
  const task = vi.spyOn(port, 'createTask')
  const run = vi.spyOn(port, 'startRun')
  const body = { text: '/assign @builder Implement paging -- Preserve focus' }
  const first = await send(body, 'assign')
  expect(first.statusCode).toBe(200)
  expect(first.json().command).toMatchObject({ kind: 'assign', taskId: expect.any(String) })
  expect(task.mock.calls[0]![0]).toEqual({
    title: 'Implement paging',
    body: 'Preserve focus',
    assignee: 'builder',
    roomId,
  })
  expect((await send(body, 'assign')).body).toBe(first.body)
  expect(task).toHaveBeenCalledTimes(1)
  expect(run).not.toHaveBeenCalled()
})

test('model command routes remaining text with a one-shot model and stable session', async () => {
  const run = vi.spyOn(port, 'startRun')
  const first = await send({ text: '/model demo-model @builder Check this' }, 'model')
  expect(first.statusCode).toBe(200)
  expect(first.json()).toMatchObject({
    routedTo: ['builder'],
    command: { kind: 'model', model: 'demo-model' },
  })
  expect(run.mock.calls[0]![0]).toMatchObject({
    agentId: 'builder',
    input: '@builder Check this',
    model: 'demo-model',
    sessionId: `score-${roomId}-builder`,
  })
  expect((await send({ text: '/model demo-model @builder Check this' }, 'model')).body).toBe(
    first.body,
  )
  expect(run).toHaveBeenCalledTimes(1)
})

test.each([
  ['/assign @builder', 400, '/assign'],
  ['/model', 400, '/model'],
  ['/routine @builder 1h check', 501, '/routine'],
  ['/remember fact', 501, '/remember'],
  ['/skill @builder example', 501, '/skill'],
])('command %s rejects with usage and no stored message', async (text, status, usage) => {
  const response = await send({ text })
  expect(response.statusCode).toBe(status)
  expect(response.json().error.details.usage).toContain(usage)
  expect(messages()).toEqual([])
})

test('deltas append to one reply, finish with tools and concurrent receipts start once', async () => {
  const run = vi.spyOn(port, 'startRun')
  const responses = await Promise.all([
    send({ text: 'hello' }, 'stream'),
    send({ text: 'hello' }, 'stream'),
  ])
  expect(responses[0]!.body).toBe(responses[1]!.body)
  expect(run).toHaveBeenCalledTimes(1)
  const reply = messages().find((message) => message.author.kind === 'agent')!
  expect(reply).toMatchObject({
    streaming: true,
    parts: [],
    refs: [{ kind: 'run', runId: expect.any(String) }],
  })
  await advance(410)
  expect(messages().find((message) => message.id === reply.id)).toMatchObject({
    streaming: true,
    parts: [{ kind: 'text', text: 'The streamed reply is re' }],
  })
  await advance(1000)
  const complete = MessageSchema.parse(messages().find((message) => message.id === reply.id))
  expect(complete).toMatchObject({
    streaming: false,
    parts: [
      { kind: 'text', text: 'The streamed reply is ready.' },
      { kind: 'tools', summary: 'Ran 3 commands and edited 2 files' },
    ],
  })
  expect(
    events().filter((event) => event.type === 'message.delta' && event.data.messageId === reply.id),
  ).toHaveLength(2)
  expect(
    events().filter(
      (event) => event.type === 'message.completed' && event.data.messageId === reply.id,
    ),
  ).toHaveLength(1)
})

test('reply mentions hand off and stop A to B to A with a visible notice', async () => {
  replies.lead = '@builder please continue'
  replies.builder = '@lead please review'
  const run = vi.spyOn(port, 'startRun')
  await send({ text: 'hello' })
  await advance(2400)
  expect(run.mock.calls.map(([req]) => req.agentId)).toEqual(['lead', 'builder'])
  expect(events().filter((event) => event.type === 'handoff.created')).toHaveLength(1)
  expect(
    messages().find(
      (message) => message.author.kind === 'agent' && message.author.agentId === 'builder',
    )!.parts,
  ).toContainEqual({ kind: 'text', text: 'Hand-off limit reached' })
})

test('a longer directed cycle stops after four hand-offs', async () => {
  replies.lead = '@builder continue'
  replies.builder = '@reviewer continue'
  replies.reviewer = '@designer continue'
  replies.designer = '@lead continue'
  const run = vi.spyOn(port, 'startRun')
  await send({ text: 'hello' })
  await advance(6000)
  expect(run.mock.calls.map(([req]) => req.agentId)).toEqual([
    'lead',
    'builder',
    'reviewer',
    'designer',
    'lead',
  ])
  expect(events().filter((event) => event.type === 'handoff.created')).toHaveLength(4)
  expect(
    messages().filter((message) =>
      message.parts.some((part) => part.kind === 'text' && part.text === 'Hand-off limit reached'),
    ),
  ).toHaveLength(1)
})

test('same-room turns serialize, build bounded redacted context at admission and survive dispatcher restart', async () => {
  const run = vi.spyOn(port, 'startRun')
  await send({ text: 'first' })
  await send({ text: 'second' })
  expect(run).toHaveBeenCalledTimes(1)
  await ingest.submit({
    source: 'test',
    identity: 'context',
    apply({ sqlite, now }) {
      const message: Message = {
        id: 'context',
        roomId,
        author: { kind: 'you' },
        to: [],
        parts: [{ kind: 'text', text: 'TOKEN=never-store-this ' + 'é'.repeat(6000) }],
        refs: [],
        streaming: false,
        createdAt: now,
      }
      return storeMessage(sqlite, message, now)
    },
  })
  await app.close()
  const restarted = new RoutingDispatcher(db, ingest, port, () => undefined)
  try {
    await restarted.dispatch()
    expect(run).toHaveBeenCalledTimes(1)
    await advance(1100)
    expect(run).toHaveBeenCalledTimes(2)
    const input = run.mock.calls[1]![0].input
    expect(input).toContain('[redacted]')
    expect(input).not.toContain('never-store-this')
    expect(Buffer.byteLength(input.split('Room context:\n')[1]!)).toBeLessThanOrEqual(8192)
  } finally {
    await restarted.close()
  }
})

test('an uncertain admission holds later turns and retries the same frozen input', async () => {
  const run = vi.spyOn(port, 'startRun').mockRejectedValueOnce(new Error('admission unavailable'))
  expect((await send({ text: 'first' }, 'uncertain')).statusCode).toBe(500)
  run.mockRejectedValueOnce(new Error('still unavailable'))
  expect((await send({ text: 'second' })).statusCode).toBe(500)
  expect(run.mock.calls.map(([req]) => req.input)).toEqual(['first', 'first'])
  await app.close()
  const restarted = new RoutingDispatcher(db, ingest, port, () => undefined)
  try {
    await restarted.dispatch()
    expect(run.mock.calls[2]![0]).toEqual(run.mock.calls[0]![0])
    expect(run).toHaveBeenCalledTimes(3)
    await advance(1100)
    expect(run).toHaveBeenCalledTimes(4)
    expect(run.mock.calls[3]![0].input).toMatch(/^second/)
  } finally {
    await restarted.close()
  }
})

test('a permanent start refusal fails the turn once, posts a notice and frees the queue', async () => {
  const run = vi
    .spyOn(port, 'startRun')
    .mockRejectedValueOnce(new HttpError(404, 'not_found', 'Unknown agent'))
  expect((await send({ text: 'first' })).statusCode).toBe(200)
  expect(db.sqlite.prepare('SELECT state FROM message_runs ORDER BY rowid').all()).toEqual([
    { state: 'failed' },
  ])
  expect(messages().at(-1)).toMatchObject({
    author: { kind: 'agent', agentId: 'lead' },
    parts: [{ kind: 'text', text: "Couldn't start this agent (not_found)." }],
    streaming: false,
  })
  await advance(11_000)
  expect(run).toHaveBeenCalledTimes(1)
  expect((await send({ text: 'second' })).statusCode).toBe(200)
  expect(run).toHaveBeenCalledTimes(2)
  expect(run.mock.calls[1]![0].input).toMatch(/second/)
})
