import { MessageSchema, RoomSchema, type Message } from '@score/contract'
import { expect, test, vi } from 'vitest'
import { RoutingDispatcher } from '../../src/domain/routing-dispatch.ts'
import { storeMessage } from '../../src/domain/rooms.ts'
import { HttpError } from '../../src/errors.ts'
import { resetDatabaseHistory } from '../../src/history-reset.ts'

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

test('FU #3: a frozen home pumps no chat reply; the reply stays queued until the freeze is gone', async () => {
  let holding: string | null = 'Score is holding all agent work: this folder is a copy.'
  Object.assign(port, { executionHold: () => holding })
  const run = vi.spyOn(port, 'startRun')
  await send({ text: 'while frozen' })
  expect(run).not.toHaveBeenCalled()
  expect(
    db.sqlite.prepare("SELECT count(*) AS n FROM message_runs WHERE state = 'pending'").get(),
  ).toEqual({ n: 1 })
  holding = null
  await app.close()
  const restarted = new RoutingDispatcher(db, ingest, port, () => undefined)
  try {
    await restarted.dispatch()
    expect(run).toHaveBeenCalledTimes(1)
  } finally {
    await restarted.close()
    Object.assign(port, { executionHold: undefined })
  }
})

test('FU #4: reset-history retires a queued chat reply: nothing is dispatched after the reset', async () => {
  let holding: string | null = 'Score is holding all agent work: this folder is a copy.'
  Object.assign(port, { executionHold: () => holding })
  const run = vi.spyOn(port, 'startRun')
  await send({ text: 'queued while frozen' })
  expect(run).not.toHaveBeenCalled()
  // The probe of re-review 5: an inherited pending reply with no command intent survived the reset and was dispatched.
  resetDatabaseHistory(db.sqlite, new Date().toISOString())
  holding = null
  await app.close()
  const restarted = new RoutingDispatcher(db, ingest, port, () => undefined)
  try {
    await restarted.dispatch()
    await advance(1100)
    expect(run).not.toHaveBeenCalled()
    expect(db.sqlite.prepare('SELECT state FROM message_runs').all()).toEqual([{ state: 'failed' }])
  } finally {
    await restarted.close()
    Object.assign(port, { executionHold: undefined })
  }
})

test('FT #4: reset-history retires an active reply with a run: a late @mention is no hand-off and Stop has no handle', async () => {
  replies.lead = `${'Working through the details. '.repeat(30)} @builder please check`
  const run = vi.spyOn(port, 'startRun')
  await send({ text: 'long reply please' })
  await advance(600)
  const writing = messages().find((message) => message.author.kind === 'agent')!
  expect(writing.streaming).toBe(true)
  expect(db.sqlite.prepare('SELECT run_id, state FROM message_runs').get()).toMatchObject({
    state: 'active',
  })
  // The probe of re-review 6: an active reply with a live run survives the reset and its late output hands off.
  resetDatabaseHistory(db.sqlite, new Date().toISOString())
  expect(
    db.sqlite.prepare("SELECT count(*) AS n FROM runs WHERE status IN ('queued','running')").get(),
  ).toEqual({ n: 0 })
  await advance(30_000)
  expect(run.mock.calls.map(([req]) => req.agentId)).toEqual(['lead'])
  expect(
    db.sqlite.prepare("SELECT 1 FROM message_runs WHERE agent_id = 'builder'").get(),
  ).toBeUndefined()
  expect(
    db.sqlite
      .prepare("SELECT count(*) AS n FROM message_runs WHERE state IN ('pending','active')")
      .get(),
  ).toEqual({ n: 0 })
  const stopped = await post(`/api/rooms/${roomId}/messages/${writing.id}/stop`, {})
  expect(stopped.statusCode).toBe(409)
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
