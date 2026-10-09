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
import { reserveMessageRun } from '../../src/domain/message-runs.ts'

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

test('/model <alias> runs on the model the alias of that agent stands for', async () => {
  await port.updateModelSettings('builder', {
    aliases: [{ name: 'quick', model: 'local-gpt-mini', provider: 'local' }],
  })
  const run = vi.spyOn(port, 'startRun')
  const sent = await send({ text: '/model Quick @builder Check this' }, 'alias')
  expect(sent.statusCode).toBe(200)
  expect(run.mock.calls[0]![0]).toMatchObject({
    agentId: 'builder',
    model: 'local-gpt-mini',
    provider: 'local',
  })
})

test('/model <alias> with a custom endpoint is refused before anything is queued (audit5-e)', async () => {
  const real = port.readModelSettings.bind(port)
  vi.spyOn(port, 'readModelSettings').mockImplementation(async (agentId) => ({
    ...(await real(agentId)),
    aliases: [{ name: 'private', model: 'gpt-x', provider: 'openrouter', editable: false }],
  }))
  const run = vi.spyOn(port, 'startRun')
  const sent = await send({ text: '/model private @builder Check this' }, 'custom-alias')
  expect(sent.statusCode).toBe(409)
  expect(sent.json()).toMatchObject({ error: { message: expect.stringContaining('custom endpoint') } })
  await advance(100)
  expect(run).not.toHaveBeenCalled()
})

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

test('the instruction reaches the agent verbatim, credential-looking values included', async () => {
  const run = vi.spyOn(port, 'startRun')
  expect((await send({ text: 'Set token=fixture-value in the test.' })).statusCode).toBe(200)
  expect(run.mock.calls[0]![0].input).toContain('token=fixture-value')
})

test('assign creates one task and receipt replay never reroutes', async () => {
  const task = vi.spyOn(port, 'createTask')
  const run = vi.spyOn(port, 'startRun')
  const body = { text: '/assign @builder Implement paging -- Preserve focus' }
  const first = await send(body, 'assign')
  expect(first.statusCode).toBe(200)
  expect(first.json().command).toMatchObject({
    kind: 'assign',
    taskId: expect.any(String),
    taskKey: expect.stringMatching(/^T-/),
  })
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
  ['/routine @builder', 400, '/routine'],
  ['/remember fact', 501, '/remember'],
  ['/skill @builder example', 501, '/skill'],
])('command %s rejects with usage and no stored message', async (text, status, usage) => {
  const response = await send({ text })
  expect(response.statusCode).toBe(status)
  expect(response.json().error.details.usage).toContain(usage)
  expect(messages()).toEqual([])
})

test('/routine creates a routine for the agent, stores the message and starts no run', async () => {
  const run = vi.spyOn(port, 'startRun')
  const response = await send({ text: '/routine @builder every 2h check the build' }, 'routine-key')
  expect(response.statusCode).toBe(200)
  const { command, routedTo } = response.json()
  expect(routedTo).toEqual([])
  expect(command).toEqual({ kind: 'routine', routineId: expect.stringMatching(/^builder:/) })
  expect(run).not.toHaveBeenCalled()
  expect(await port.listRoutines('builder')).toMatchObject([
    { id: command.routineId, schedule: 'every 2h', description: 'check the build', enabled: true },
  ])
  expect(messages()).toHaveLength(1)
  const replay = await send({ text: '/routine @builder every 2h check the build' }, 'routine-key')
  expect(replay.json().command).toEqual(command)
  expect(await port.listRoutines('builder')).toHaveLength(1)
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
    // The unfinished word is held back until it settles (split-secret redaction).
    parts: [{ kind: 'text', text: 'The streamed reply is ' }],
  })
  await advance(1000)
  const complete = MessageSchema.parse(messages().find((message) => message.id === reply.id))
  expect(complete).toMatchObject({
    streaming: false,
  })
  // Tool calls and reasoning come first as cards (PLAN 5.25), the text after; the compact summary is for old messages.
  expect(complete.parts.map((part) => part.kind)).toEqual([
    'thinking',
    ...Array.from({ length: 5 }, () => 'tool'),
    'text',
  ])
  expect(complete.parts.at(-1)).toEqual({ kind: 'text', text: 'The streamed reply is ready.' })
  expect(complete.parts[1]).toEqual({
    kind: 'tool',
    tool: 'terminal',
    args: 'pnpm test',
    result: '3 checks passed',
    status: 'ok',
  })
  expect(
    events().filter((event) => event.type === 'message.delta' && event.data.messageId === reply.id),
  ).toHaveLength(2)
  expect(
    events().filter(
      (event) => event.type === 'message.completed' && event.data.messageId === reply.id,
    ),
  ).toHaveLength(1)
  // The completion event carries the final parts (the tools summary was added at completion, not by a delta).
  expect(
    events().find(
      (event) => event.type === 'message.completed' && event.data.messageId === reply.id,
    )?.data,
  ).toMatchObject({ parts: complete.parts })
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
