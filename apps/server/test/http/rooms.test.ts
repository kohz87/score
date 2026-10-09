import { MessageSchema, RoomSchema, StreamEventSchema, type Message } from '@score/contract'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { z } from 'zod'
import { buildApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { migrate, openDatabase, type ScoreDb } from '../../src/db/index.ts'
import { readRoom, storeMessage, updateMessage } from '../../src/domain/rooms.ts'
import { createHermesPort, type HermesPort } from '../../src/hermes/index.ts'
import { createIngest, type Ingest } from '../../src/hub/ingest.ts'
import { FakeScheduler } from '../hermes/fake-scheduler.ts'
import { createScenario, scenarioDuration } from '../../src/hermes/fake/scenario.ts'
import { stepToObservation } from '../../src/hermes/fake/fake-port.ts'

const ListSchema = z.object({
  asOfSeq: z.int().nonnegative(),
  rooms: z.array(RoomSchema),
  directs: z.array(RoomSchema),
})
const DetailSchema = z.object({
  asOfSeq: z.int().nonnegative(),
  room: RoomSchema,
  filesInPlay: z.array(z.string()),
  learned: z.array(
    z.object({ text: z.string(), savedTo: z.array(z.string()), at: z.iso.datetime() }),
  ),
})
const PageSchema = z.object({
  asOfSeq: z.int().nonnegative(),
  items: z.array(MessageSchema),
  nextCursor: z.string().nullable(),
})
const PostSchema = z.object({
  message: MessageSchema,
  routedTo: z.array(z.string()),
  command: z.null(),
})
let dir: string
let db: ScoreDb
let ingest: Ingest
let port: HermesPort
let scheduler: FakeScheduler
let app: ReturnType<typeof buildApp>
let headers: { 'x-score-client': string; cookie: string }
let counter: number

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'score-rooms-'))
  db = openDatabase(join(dir, 'score.db'))
  migrate(db, fileURLToPath(new URL('../../migrations/', import.meta.url)))
  scheduler = new FakeScheduler()
  const clock = () => scheduler.now()
  ingest = createIngest(db, { clock })
  port = createHermesPort(loadConfig({ SCORE_MODE: 'fake', SCORE_FAKE_LOOP: 'false' }), {
    db,
    scheduler,
  })
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
  counter = 0
  vi.spyOn(port, 'startRun').mockResolvedValue({ runId: 'room-test-run' })
})
afterEach(async () => {
  vi.restoreAllMocks()
  await port.stop()
  await app.close()
  await ingest.close()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})
const get = (url: string) => app.inject({ method: 'GET', url })
const post = (url: string, payload: object, key?: string) =>
  app.inject({
    method: 'POST',
    url,
    headers: { ...headers, ...(key ? { 'idempotency-key': key } : {}) },
    payload,
  })
async function create(name = 'team') {
  const response = await post('/api/rooms', {
    name,
    leadAgentId: 'lead',
    members: ['lead', 'builder', 'builder'],
  })
  expect(response.statusCode).toBe(200)
  return RoomSchema.parse(response.json())
}
function events() {
  return db.sqlite
    .prepare('SELECT seq, ts, type, data FROM events ORDER BY seq')
    .all()
    .map((row) =>
      StreamEventSchema.parse({ ...row, data: JSON.parse(String(row.data)) as unknown }),
    )
}
async function agentMessage(roomId: string, id = `agent-${++counter}`, agentId = 'builder') {
  const message: Message = {
    id,
    roomId,
    author: { kind: 'agent', agentId },
    to: [],
    parts: [{ kind: 'text', text: id }],
    refs: [],
    createdAt: new Date(scheduler.now()).toISOString(),
    streaming: false,
  }
  await ingest.submit({
    source: 'test',
    identity: `message-${counter}-${id}`,
    apply: ({ sqlite, now }) => storeMessage(sqlite, message, now),
  })
  return message
}

test('every room endpoint returns its contract shape and mutations emit once', async () => {
  const room = await create()
  expect(room).toMatchObject({
    name: '#team',
    kind: 'room',
    members: ['lead', 'builder'],
    unread: 0,
    activeAgents: [],
    channels: [],
  })
  const listed = ListSchema.parse((await get('/api/rooms')).json())
  expect(listed.rooms).toEqual([room])
  expect(listed.directs).toHaveLength(4)
  const detail = DetailSchema.parse((await get(`/api/rooms/${room.id}`)).json())
  expect(detail).toMatchObject({ room, filesInPlay: [], learned: [] })
  const patch = await app.inject({
    method: 'PATCH',
    url: `/api/rooms/${room.id}`,
    headers,
    payload: { name: 'renamed', leadAgentId: 'reviewer', members: ['reviewer', 'reviewer'] },
  })
  expect(patch.statusCode).toBe(200)
  expect(RoomSchema.parse(patch.json())).toMatchObject({
    name: '#renamed',
    leadAgentId: 'reviewer',
    members: ['reviewer'],
  })
  const response = await post(`/api/rooms/${room.id}/messages`, {
    text: '@builder /assign later',
    to: ['builder', 'builder'],
    planFirst: true,
    model: 'demo-model',
    attachments: [],
  })
  expect(response.statusCode).toBe(200)
  const result = PostSchema.parse(response.json())
  expect(result).toMatchObject({
    routedTo: ['builder'],
    command: null,
    message: {
      author: { kind: 'you' },
      to: ['builder'],
      parts: [{ kind: 'text', text: '@builder /assign later' }],
      streaming: false,
    },
  })
  const page = PageSchema.parse((await get(`/api/rooms/${room.id}/messages`)).json())
  expect(page.items).toEqual([result.message])
  expect(page.nextCursor).toBeNull()
  expect(events().filter((event) => event.type === 'message.created')).toHaveLength(1)
  expect(
    events().filter((event) => event.type === 'room.upserted' && event.data.id === room.id),
  ).toHaveLength(2)
})

test('concurrent lazy direct creation is idempotent, with one direct per known agent', async () => {
  const responses = await Promise.all([get('/api/rooms'), get('/api/rooms'), get('/api/rooms')])
  const lists = responses.map((response) => ListSchema.parse(response.json()))
  expect(lists[1]).toEqual(lists[0])
  expect(lists[2]).toEqual(lists[0])
  const agents = await port.listAgents()
  expect(
    lists[0]!.directs.map((room) => ({
      name: room.name,
      leadAgentId: room.leadAgentId,
      members: room.members,
    })),
  ).toEqual(
    agents
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((agent) => ({ name: agent.name, leadAgentId: agent.id, members: [agent.id] })),
  )
  expect(events().filter((event) => event.type === 'room.upserted')).toHaveLength(4)
  vi.spyOn(port, 'listAgents').mockResolvedValue(agents.slice(0, 2))
  expect(ListSchema.parse((await get('/api/rooms')).json()).directs).toHaveLength(2)
})

test('paging uses descending timestamp/id, has no overlap, and older pages do not mark read', async () => {
  const room = await create()
  for (const id of ['a', 'c', 'b']) await agentMessage(room.id, id)
  const time = new Date(scheduler.now()).toISOString()
  const cursor = Buffer.from(
    JSON.stringify({ roomId: room.id, createdAt: time, id: 'z' }),
  ).toString('base64url')
  const old = PageSchema.parse(
    (await get(`/api/rooms/${room.id}/messages?before=${cursor}&limit=2`)).json(),
  )
  expect(old.items.map((message) => message.id)).toEqual(['c', 'b'])
  expect(DetailSchema.parse((await get(`/api/rooms/${room.id}`)).json()).room.unread).toBe(3)
  const first = PageSchema.parse((await get(`/api/rooms/${room.id}/messages?limit=2`)).json())
  const second = PageSchema.parse(
    (await get(`/api/rooms/${room.id}/messages?before=${first.nextCursor}&limit=2`)).json(),
  )
  expect(first.items.map((message) => message.id)).toEqual(['c', 'b'])
  expect(second.items.map((message) => message.id)).toEqual(['a'])
  expect(second.nextCursor).toBeNull()
  expect(DetailSchema.parse((await get(`/api/rooms/${room.id}`)).json()).room.unread).toBe(0)
  const count = events().length
  await get(`/api/rooms/${room.id}/messages`)
  expect(events()).toHaveLength(count)
  await scheduler.advance(1)
  await agentMessage(room.id, 'd')
  expect(DetailSchema.parse((await get(`/api/rooms/${room.id}`)).json()).room.unread).toBe(1)
  await get(`/api/rooms/${room.id}/messages?before=${first.nextCursor}`)
  expect(DetailSchema.parse((await get(`/api/rooms/${room.id}`)).json()).room.unread).toBe(1)
})

test('reading an empty streaming placeholder does not acknowledge the answer that fills it', async () => {
  const room = await create()
  const placeholder: Message = {
    id: 'placeholder',
    roomId: room.id,
    author: { kind: 'agent', agentId: 'builder' },
    to: [],
    parts: [],
    refs: [],
    createdAt: new Date(scheduler.now()).toISOString(),
    streaming: true,
  }
  await ingest.submit({
    source: 'test',
    identity: 'placeholder',
    apply: ({ sqlite, now }) => storeMessage(sqlite, placeholder, now),
  })
  await get(`/api/rooms/${room.id}/messages`)
  await ingest.submit({
    source: 'test',
    identity: 'placeholder-fill',
    apply: ({ sqlite, now }) => [
      ...updateMessage(sqlite, room.id, 'placeholder', 'The answer.', now),
      ...updateMessage(sqlite, room.id, 'placeholder', null, now),
    ],
  })
  expect(DetailSchema.parse((await get(`/api/rooms/${room.id}`)).json()).room.unread).toBe(1)
})

test('read marker persists across reopen and activity expires with a single room event', async () => {
  const room = await create()
  await agentMessage(room.id)
  await agentMessage(room.id, 'review', 'reviewer')
  expect(DetailSchema.parse((await get(`/api/rooms/${room.id}`)).json()).room.activeAgents).toEqual(
    ['builder', 'reviewer'],
  )
  await get(`/api/rooms/${room.id}/messages`)
  await app.close()
  await ingest.close()
  db.close()
  db = openDatabase(join(dir, 'score.db'))
  ingest = createIngest(db, { clock: () => scheduler.now() })
  app = buildApp({
    config: loadConfig({ SCORE_MODE: 'fake' }),
    logger: false,
    db,
    ingest,
    port,
    clock: () => scheduler.now(),
  })
  expect(DetailSchema.parse((await get(`/api/rooms/${room.id}`)).json()).room.unread).toBe(0)
  await scheduler.advance(600000)
  const count = events().length
  expect(DetailSchema.parse((await get(`/api/rooms/${room.id}`)).json()).room.activeAgents).toEqual(
    [],
  )
  expect(events()).toHaveLength(count + 1)
  expect(events().at(-1)).toMatchObject({
    type: 'room.upserted',
    data: { unread: 0, activeAgents: [] },
  })
  await get(`/api/rooms/${room.id}`)
  expect(events()).toHaveLength(count + 1)
})

test('room creates, updates and message posts replay exact receipts with no repeated events', async () => {
  const createRequest = () =>
    post('/api/rooms', { name: 'receipted', leadAgentId: 'lead' }, 'create')
  const created = await Promise.all([createRequest(), createRequest()])
  expect(created[1]!.body).toBe(created[0]!.body)
  const room = RoomSchema.parse(created[0]!.json())
  const patch = () =>
    app.inject({
      method: 'PATCH',
      url: `/api/rooms/${room.id}`,
      headers: { ...headers, 'idempotency-key': 'patch' },
      payload: { name: 'receipt-updated' },
    })
  const patched = await Promise.all([patch(), patch()])
  expect(patched[1]!.body).toBe(patched[0]!.body)
  const send = () => post(`/api/rooms/${room.id}/messages`, { text: 'Hello' }, 'message')
  const messages = await Promise.all([send(), send(), send()])
  expect(messages.map((response) => response.body)).toEqual([
    messages[0]!.body,
    messages[0]!.body,
    messages[0]!.body,
  ])
  expect(PostSchema.parse(messages[0]!.json()).message.parts).toEqual([
    { kind: 'text', text: 'Hello' },
  ])
  expect(events().map((event) => event.type)).toEqual([
    'room.upserted',
    'room.upserted',
    'message.created',
    'brief.upserted',
  ])
  expect(
    (await post(`/api/rooms/${room.id}/messages`, { text: 'Changed' }, 'message')).statusCode,
  ).toBe(409)
})

test.each([
  { name: '' },
  { name: 'Upper' },
  { name: '-bad' },
  { name: '#a'.repeat(33) },
  { name: 'x'.repeat(65) },
  { name: 'valid', leadAgentId: 'unknown' },
  { name: 'valid', members: ['unknown'] },
])('invalid room input yields 400: %j', async (body) => {
  expect((await post('/api/rooms', body)).statusCode).toBe(400)
  expect(events()).toHaveLength(0)
})

test.each([
  { text: '' },
  { text: 'x'.repeat(16385) },
  { text: 'é'.repeat(8193) },
  { text: 'hello', to: ['unknown'] },
  { text: 'hello', planFirst: 'yes' },
  { text: 'hello', attachments: [{ mediaId: '' }] },
])('invalid message input yields 400: %#', async (body) => {
  const room = await create()
  expect((await post(`/api/rooms/${room.id}/messages`, body)).statusCode).toBe(400)
  expect(events().filter((event) => event.type === 'message.created')).toHaveLength(0)
})

test('text accepts exactly 16 KB including multibyte UTF-8', async () => {
  const room = await create()
  expect(
    (await post(`/api/rooms/${room.id}/messages`, { text: 'é'.repeat(8192) })).statusCode,
  ).toBe(200)
})

test('unknown rooms, conflicting names, invalid patch and cursors return 400/404/409', async () => {
  const room = await create()
  expect((await post('/api/rooms', { name: '#team' })).statusCode).toBe(409)
  const other = await create('other')
  expect(
    (
      await app.inject({
        method: 'PATCH',
        url: `/api/rooms/${other.id}`,
        headers,
        payload: { name: 'team' },
      })
    ).statusCode,
  ).toBe(409)
  expect(
    (await app.inject({ method: 'PATCH', url: `/api/rooms/${room.id}`, headers, payload: {} }))
      .statusCode,
  ).toBe(400)
  expect(
    (
      await app.inject({
        method: 'PATCH',
        url: `/api/rooms/${room.id}`,
        headers,
        payload: { members: ['unknown'] },
      })
    ).statusCode,
  ).toBe(400)
  expect((await get('/api/rooms/missing')).statusCode).toBe(404)
  expect((await get('/api/rooms/missing/messages')).statusCode).toBe(404)
  expect((await post('/api/rooms/missing/messages', { text: 'hello' })).statusCode).toBe(404)
  expect(
    (
      await app.inject({
        method: 'PATCH',
        url: '/api/rooms/missing',
        headers,
        payload: { name: 'valid' },
      })
    ).statusCode,
  ).toBe(404)
  for (const query of [
    'limit=0',
    'limit=101',
    'limit=1.5',
    'before=garbage',
    'before=',
    'before=%25',
    'limit=wat',
  ])
    expect((await get(`/api/rooms/${room.id}/messages?${query}`)).statusCode).toBe(400)
  const cursor = Buffer.from(
    JSON.stringify({
      roomId: other.id,
      createdAt: new Date(scheduler.now()).toISOString(),
      id: 'a',
    }),
  ).toString('base64url')
  expect((await get(`/api/rooms/${room.id}/messages?before=${cursor}`)).statusCode).toBe(400)
})

test.each(['create', 'patch', 'message'] as const)(
  'human guard and CSRF protect %s',
  async (operation) => {
    const room = await create()
    const url =
      operation === 'create'
        ? '/api/rooms'
        : operation === 'patch'
          ? `/api/rooms/${room.id}`
          : `/api/rooms/${room.id}/messages`
    const method = operation === 'patch' ? 'PATCH' : 'POST'
    const payload = operation === 'message' ? { text: 'hi' } : { name: 'guarded' }
    expect(
      (await app.inject({ method, url, payload, headers: { 'x-score-client': 'web' } })).statusCode,
    ).toBe(401)
    expect(
      (await app.inject({ method, url, payload, headers: { cookie: headers.cookie } })).statusCode,
    ).toBe(403)
    expect(
      (
        await app.inject({
          method,
          url,
          payload,
          headers: { ...headers, origin: 'https://untrusted.example' },
        })
      ).statusCode,
    ).toBe(403)
  },
)

test('fake scenario persists full conversation, deltas, completion and unread via the API', async () => {
  await port.start(ingest)
  await scheduler.advance(scenarioDuration)
  const list = ListSchema.parse((await get('/api/rooms')).json())
  const room = list.rooms.find((room) => room.id === 'room-activity-feed')!
  expect(room).toMatchObject({
    name: '#activity-feed',
    unread: 4,
    activeAgents: ['builder', 'lead', 'reviewer'],
  })
  const page = PageSchema.parse((await get(`/api/rooms/${room.id}/messages`)).json())
  expect(page.items.map((message) => message.id)).toEqual([
    'message-review-0',
    'message-build-files-0',
    'approval:approval-score-run-0',
    'message-plan-0',
    'message-brief-0',
  ])
  expect(page.items.every((message) => !message.streaming)).toBe(true)
  expect(page.items[0]!.parts).toEqual([
    {
      kind: 'text',
      text: 'The cursor and loading states look good. Keyboard focus stays in place after loading. Ready to merge after the final checks.',
    },
  ])
  expect(page.items[2]!.parts).toEqual([{ kind: 'approval', approvalId: 'approval-score-run-0' }])
  expect(page.items[3]!.parts[0]).toMatchObject({
    kind: 'text',
    text: expect.stringContaining('Keep keyboard focus on the load button.'),
  })
  expect(DetailSchema.parse((await get(`/api/rooms/${room.id}`)).json()).filesInPlay).toEqual([
    'src/activity-feed.ts',
    'src/feed-card.css',
  ])
  expect(DetailSchema.parse((await get(`/api/rooms/${room.id}`)).json()).room.unread).toBe(0)
  const count = events().length
  const replay = createScenario(scheduler.now()).filter((step) => step.kind.startsWith('message.'))
  for (const [index, step] of replay.entries())
    await ingest.submit(stepToObservation(step, `replay-${index}`))
  expect(events()).toHaveLength(count)
  expect(PageSchema.parse((await get(`/api/rooms/${room.id}/messages`)).json()).items).toEqual(
    page.items,
  )
})

test('queued arrivals after the page snapshot remain unread and newer than its watermark', async () => {
  const room = await create()
  await agentMessage(room.id, 'first')
  await scheduler.advance(1)
  const submit = ingest.submit.bind(ingest)
  let intercepted = false
  vi.spyOn(ingest, 'submit').mockImplementation((observation) => {
    if (!intercepted && observation.source === 'rooms') {
      intercepted = true
      const message: Message = {
        id: 'second',
        roomId: room.id,
        author: { kind: 'agent', agentId: 'builder' },
        to: [],
        parts: [],
        refs: [],
        streaming: false,
        createdAt: new Date(scheduler.now()).toISOString(),
      }
      void submit({
        source: 'race',
        identity: 'arrival',
        apply: ({ sqlite, now }) => storeMessage(sqlite, message, now),
      })
    }
    return submit(observation)
  })
  const page = PageSchema.parse((await get(`/api/rooms/${room.id}/messages`)).json())
  expect(page.items.map((message) => message.id)).toEqual(['first'])
  const arrival = events().find(
    (event) => event.type === 'message.created' && event.data.id === 'second',
  )!
  expect(arrival.seq).toBeGreaterThan(page.asOfSeq)
  expect(DetailSchema.parse((await get(`/api/rooms/${room.id}`)).json()).room.unread).toBe(1)
})

test('idempotent messages preserve 16 KB text even when JSON escaping exceeds 64 KB', async () => {
  const room = await create()
  const text = '\u0001'.repeat(16384)
  const first = await post(`/api/rooms/${room.id}/messages`, { text }, 'escaped')
  expect(first.statusCode).toBe(200)
  expect(PostSchema.parse(first.json()).message.parts).toEqual([{ kind: 'text', text }])
  expect((await post(`/api/rooms/${room.id}/messages`, { text }, 'escaped')).body).toBe(first.body)
  expect(events().filter((event) => event.type === 'message.created')).toHaveLength(1)
})

test('no-op room patches emit nothing and direct rooms retain their agent identity', async () => {
  const room = await create()
  const count = events().length
  const response = await app.inject({
    method: 'PATCH',
    url: `/api/rooms/${room.id}`,
    headers,
    payload: { name: '#team' },
  })
  expect(response.statusCode).toBe(200)
  expect(events()).toHaveLength(count)
  const direct = ListSchema.parse((await get('/api/rooms')).json()).directs[0]!
  const otherAgent = direct.leadAgentId === 'lead' ? 'builder' : 'lead'
  expect(
    (
      await app.inject({
        method: 'PATCH',
        url: `/api/rooms/${direct.id}`,
        headers,
        payload: { leadAgentId: otherAgent },
      })
    ).statusCode,
  ).toBe(409)
})

test('fake deltas append to the last text part, completion is terminal, and duplicate observations are dropped', async () => {
  const room = await create()
  const message: Message = {
    id: 'stream-test',
    roomId: room.id,
    author: { kind: 'agent', agentId: 'builder' },
    to: [],
    parts: [
      { kind: 'text', text: 'First' },
      { kind: 'text', text: 'Last' },
      { kind: 'tools', summary: 'Tests', runId: 'demo' },
    ],
    refs: [],
    createdAt: new Date(scheduler.now()).toISOString(),
    streaming: true,
  }
  await ingest.submit(
    stepToObservation({ at: 0, kind: 'message.created', data: message }, 'stream-created'),
  )
  const delta = stepToObservation(
    {
      at: 0,
      kind: 'message.delta',
      data: { roomId: room.id, messageId: message.id, append: ' appended' },
    },
    'stream-delta',
  )
  await ingest.submit(delta)
  expect((await ingest.submit(delta)).status).toBe('duplicate')
  await ingest.submit(
    stepToObservation(
      { at: 0, kind: 'message.completed', data: { roomId: room.id, messageId: message.id } },
      'stream-completed',
    ),
  )
  const before = events().length
  await ingest.submit(
    stepToObservation(
      {
        at: 0,
        kind: 'message.delta',
        data: { roomId: room.id, messageId: message.id, append: ' late' },
      },
      'stream-late',
    ),
  )
  await ingest.submit(
    stepToObservation(
      { at: 0, kind: 'message.completed', data: { roomId: room.id, messageId: message.id } },
      'stream-completed-again',
    ),
  )
  expect(events()).toHaveLength(before)
  const stored = PageSchema.parse((await get(`/api/rooms/${room.id}/messages`)).json()).items[0]!
  expect(stored).toMatchObject({
    streaming: false,
    parts: [
      { kind: 'text', text: 'First' },
      { kind: 'text', text: 'Last appended' },
      { kind: 'tools', summary: 'Tests', runId: 'demo' },
    ],
  })
})

test('room/message projections roll back together with their events on a failed ingest', async () => {
  const room = await create()
  const count = events().length
  await expect(
    ingest.submit({
      source: 'test',
      identity: 'rollback',
      apply({ sqlite, now }) {
        storeMessage(
          sqlite,
          {
            id: 'rollback',
            roomId: room.id,
            author: { kind: 'agent', agentId: 'builder' },
            to: [],
            parts: [],
            refs: [],
            createdAt: now,
            streaming: false,
          },
          now,
        )
        throw new Error('projection failed')
      },
    }),
  ).rejects.toThrow('projection failed')
  expect(PageSchema.parse((await get(`/api/rooms/${room.id}/messages`)).json()).items).toEqual([])
  expect(DetailSchema.parse((await get(`/api/rooms/${room.id}`)).json()).room).toMatchObject({
    unread: 0,
    activeAgents: [],
  })
  expect(events()).toHaveLength(count)
})

test('idle activity expiry emits on the periodic sweep without an API read', async () => {
  const room = await create()
  await agentMessage(room.id)
  await app.close()
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  try {
    app = buildApp({
      config: loadConfig({ SCORE_MODE: 'fake' }),
      logger: false,
      db,
      ingest,
      port,
      clock: () => scheduler.now(),
    })
    await scheduler.advance(600000)
    const count = events().length
    await vi.advanceTimersByTimeAsync(30000)
    await ingest.drain()
    expect(events()).toHaveLength(count + 1)
    expect(events().at(-1)).toMatchObject({
      type: 'room.upserted',
      data: { id: room.id, activeAgents: [], unread: 1 },
    })
    await vi.advanceTimersByTimeAsync(30000)
    await ingest.drain()
    expect(events()).toHaveLength(count + 1)
    await app.close()
  } finally {
    vi.useRealTimers()
  }
})

test('rooms migration enforces STRICT tables, valid JSON, author constraints and indexed paging', () => {
  const tables = z
    .array(z.object({ name: z.string(), strict: z.int() }))
    .parse(db.sqlite.prepare('PRAGMA table_list').all())
  expect(
    tables
      .filter((table) => ['rooms', 'room_reads', 'messages'].includes(table.name))
      .every((table) => table.strict === 1),
  ).toBe(true)
  expect(
    db.sqlite
      .prepare("PRAGMA index_info('messages_room_created_id')")
      .all()
      .map((row) => row.name),
  ).toEqual(['room_id', 'created_at', 'id'])
  const now = new Date(scheduler.now()).toISOString()
  expect(() =>
    db.sqlite
      .prepare(
        'INSERT INTO rooms (id, name, kind, members, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run('bad', '#bad', 'room', 'invalid json', now, now),
  ).toThrow()
  expect(() =>
    db.sqlite.prepare('INSERT INTO room_reads VALUES (?, ?, ?)').run('missing', now, 'message'),
  ).toThrow()
})

test('activity cannot change between refresh and snapshot without advancing its watermark', async () => {
  const room = await create()
  await agentMessage(room.id)
  await scheduler.advance(599999)
  const submit = ingest.submit.bind(ingest)
  const spy = vi.spyOn(ingest, 'submit').mockImplementation(async (observation) => {
    const result = await submit(observation)
    await scheduler.advance(2)
    return result
  })
  const response = DetailSchema.parse((await get(`/api/rooms/${room.id}`)).json())
  expect(response.room.activeAgents).toEqual(['builder'])
  expect(events().at(-1)).toMatchObject({
    seq: response.asOfSeq,
    type: 'room.upserted',
    data: { activeAgents: ['builder'] },
  })
  spy.mockRestore()
  const refreshed = DetailSchema.parse((await get(`/api/rooms/${room.id}`)).json())
  expect(refreshed.room.activeAgents).toEqual([])
  expect(refreshed.asOfSeq).toBeGreaterThan(response.asOfSeq)
})

test('an idle activity refresh creates no observation (gate review #13)', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  const idle = buildApp({
    config: loadConfig({ SCORE_MODE: 'fake' }),
    logger: false,
    db,
    ingest,
    port,
    clock: () => scheduler.now(),
  })
  try {
    const keys = () =>
      db.sqlite.prepare(`SELECT count(*) AS n FROM ingest_keys WHERE source = 'rooms'`).get()
    const before = keys()
    await vi.advanceTimersByTimeAsync(31_000)
    await vi.advanceTimersByTimeAsync(31_000)
    expect(keys()).toEqual(before)
  } finally {
    vi.useRealTimers()
    await idle.close()
  }
})

test('GET /api/commands lists the slash commands for the composer menu', async () => {
  const response = await get('/api/commands')
  expect(response.statusCode).toBe(200)
  const body = z
    .object({
      items: z.array(
        z.object({ name: z.string(), usage: z.string().startsWith('/'), description: z.string() }),
      ),
    })
    .parse(response.json())
  expect(body.items.map((item) => item.name)).toEqual(['assign', 'routine', 'model'])
})

test('filesInPlay lists distinct file-tool paths of this room runs, newest first', async () => {
  const room = await create('files')
  const other = await create('other')
  await agentMessage(room.id, 'p1')
  await agentMessage(other.id, 'p2')
  const at = (n: number) => new Date(Date.parse('2026-10-01T00:00:00Z') + n * 1000).toISOString()
  await ingest.submit({
    source: 'test',
    identity: 'panel-fixtures',
    apply({ sqlite, now }) {
      const run = (id: string, profile: string, session: string) =>
        sqlite
          .prepare(
            `INSERT INTO runs (id, profile, origin, session_id, status, started_at, updated_at) VALUES (?, ?, 'score', ?, 'completed', ?, ?)`,
          )
          .run(id, profile, session, now, now)
      run('run-a', 'builder', 'sess-a')
      run('run-b', 'builder', 'sess-b')
      const link = (message: string, roomId: string, runId: string, n: number) =>
        sqlite
          .prepare(
            `INSERT INTO message_runs (message_id, run_id, room_id, agent_id, chain_id, hop, turn_id, parent_message_id, input, agents, state, created_at)
             VALUES (?, ?, ?, 'builder', ?, 0, ?, ?, 'x', '[]', 'completed', ?)`,
          )
          .run(`reply:${message}`, runId, roomId, message, `turn-${message}`, message, at(n))
      link('p1', room.id, 'run-a', 0)
      link('p2', other.id, 'run-b', 0)
      const tool = (runId: string, seq: number, name: string, preview: string | null, n: number) =>
        sqlite
          .prepare(
            `INSERT INTO tool_calls (run_id, seq, tool, preview, status, started_at) VALUES (?, ?, ?, ?, 'ok', ?)`,
          )
          .run(runId, seq, name, preview, at(n))
      tool('run-a', 1, 'edit_file', JSON.stringify({ path: 'src/a.ts' }), 1)
      tool('run-a', 2, 'terminal', 'ls src/b.ts', 2)
      tool('run-a', 3, 'read_file', 'src/b.ts', 3)
      tool('run-a', 4, 'edit_file', JSON.stringify({ path: './src/a.ts' }), 4)
      tool('run-a', 5, 'edit_file', null, 5)
      tool('run-b', 1, 'edit_file', JSON.stringify({ path: 'src/other-room.ts' }), 6)
      sqlite
        .prepare(
          `INSERT INTO session_tool_calls (profile, session_id, tool_call_id, tool, args_preview, status, started_at)
           VALUES ('builder', 'sess-a', 'tc1', 'write_file', ?, 'ok', ?)`,
        )
        .run(JSON.stringify({ path: 'docs/notes.md' }), at(2.5))
      return []
    },
  })
  const detail = DetailSchema.parse((await get(`/api/rooms/${room.id}`)).json())
  expect(detail.filesInPlay).toEqual(['src/a.ts', 'src/b.ts', 'docs/notes.md'])
})

test('filesInPlay is capped at 12', async () => {
  const room = await create('cap')
  await agentMessage(room.id, 'c1')
  await ingest.submit({
    source: 'test',
    identity: 'cap-fixtures',
    apply({ sqlite, now }) {
      sqlite
        .prepare(
          `INSERT INTO runs (id, profile, origin, status, started_at, updated_at) VALUES ('run-c', 'builder', 'score', 'completed', ?, ?)`,
        )
        .run(now, now)
      sqlite
        .prepare(
          `INSERT INTO message_runs (message_id, run_id, room_id, agent_id, chain_id, hop, turn_id, parent_message_id, input, agents, created_at)
           VALUES ('reply:c1', 'run-c', ?, 'builder', 'c1', 0, 'turn-c1', 'c1', 'x', '[]', ?)`,
        )
        .run(room.id, now)
      for (let i = 0; i < 15; i++)
        sqlite
          .prepare(
            `INSERT INTO tool_calls (run_id, seq, tool, preview, status, started_at) VALUES ('run-c', ?, 'edit_file', ?, 'ok', ?)`,
          )
          .run(i, JSON.stringify({ path: `f${i}.ts` }), now)
      return []
    },
  })
  const detail = DetailSchema.parse((await get(`/api/rooms/${room.id}`)).json())
  expect(detail.filesInPlay).toHaveLength(12)
})

test('learned lists memory.saved events whose source is this room, newest first, max 5', async () => {
  const room = await create('learn')
  const other = await create('elsewhere')
  const save = (identity: string, text: string, roomId: string | null) =>
    ingest.submit({
      source: 'test',
      identity,
      apply: () => [
        {
          type: 'memory.saved' as const,
          data: {
            agentIds: ['lead', 'builder'],
            text,
            source: roomId === null ? null : { kind: 'room' as const, roomId },
          },
        },
      ],
    })
  for (let i = 1; i <= 6; i++) await save(`m${i}`, `fact ${i}`, room.id)
  await save('mo', 'other room fact', other.id)
  await save('mn', 'no source', null)
  const detail = DetailSchema.parse((await get(`/api/rooms/${room.id}`)).json())
  expect(detail.learned.map((item) => item.text)).toEqual([
    'fact 6',
    'fact 5',
    'fact 4',
    'fact 3',
    'fact 2',
  ])
  expect(detail.learned[0]).toMatchObject({ savedTo: ['lead', 'builder'] })
})

test('a completion whose parts exceed the bound omits them instead of making an oversized event', async () => {
  const room = await create()
  const placeholder: Message = {
    id: 'big',
    roomId: room.id,
    author: { kind: 'agent', agentId: 'builder' },
    to: [],
    parts: [],
    refs: [],
    createdAt: new Date(scheduler.now()).toISOString(),
    streaming: true,
  }
  await ingest.submit({
    source: 'test',
    identity: 'big-create',
    apply: ({ sqlite, now }) => storeMessage(sqlite, placeholder, now),
  })
  let drafts: ReturnType<typeof updateMessage> = []
  await ingest.submit({
    source: 'test',
    identity: 'big-fill',
    apply: ({ sqlite, now }) => {
      updateMessage(sqlite, room.id, 'big', 'x'.repeat(300 * 1024), now)
      drafts = updateMessage(sqlite, room.id, 'big', null, now)
      return drafts
    },
  })
  expect(drafts).toEqual([
    { type: 'message.completed', data: { messageId: 'big', roomId: room.id } },
  ])
})

const del = (url: string, key?: string) =>
  app.inject({
    method: 'DELETE',
    url,
    headers: { ...headers, ...(key ? { 'idempotency-key': key } : {}) },
  })

test('deleting a message hides it from reads, unread and the Now thread, emits once and is idempotent', async () => {
  const room = await create()
  const first = await agentMessage(room.id, 'keep')
  const gone = await agentMessage(room.id, 'gone')
  expect(readRoomUnread(room.id)).toBe(2)
  const response = await del(`/api/rooms/${room.id}/messages/${gone.id}`)
  expect(response.statusCode).toBe(204)
  expect(response.body).toBe('')
  const page = PageSchema.parse((await get(`/api/rooms/${room.id}/messages`)).json())
  expect(page.items.map((item) => item.id)).toEqual([first.id])
  expect(readRoomUnread(room.id)).toBe(0)
  const deleted = events().filter((event) => event.type === 'message.deleted')
  expect(deleted).toHaveLength(1)
  expect(deleted[0]!.data).toEqual({ roomId: room.id, messageId: gone.id })
  // The row stays (runs and audit), marked deleted.
  expect(
    db.sqlite.prepare('SELECT deleted_at FROM messages WHERE id = ?').get(gone.id)?.deleted_at,
  ).toEqual(expect.any(String))
  const now = (await get('/api/now')).json() as { thread: { messages: { id: string }[] } | null }
  expect(now.thread?.messages.map((item) => item.id)).toEqual([first.id])
  // Deleting again changes nothing and emits nothing.
  expect((await del(`/api/rooms/${room.id}/messages/${gone.id}`)).statusCode).toBe(204)
  expect(events().filter((event) => event.type === 'message.deleted')).toHaveLength(1)
})

test('deleting needs a paired browser, a known message and a finished one', async () => {
  const room = await create()
  const streaming: Message = {
    id: 'writing',
    roomId: room.id,
    author: { kind: 'agent', agentId: 'builder' },
    to: [],
    parts: [],
    refs: [],
    createdAt: new Date(scheduler.now()).toISOString(),
    streaming: true,
  }
  await ingest.submit({
    source: 'test',
    identity: 'streaming-message',
    apply: ({ sqlite, now }) => storeMessage(sqlite, streaming, now),
  })
  expect((await del(`/api/rooms/${room.id}/messages/writing`)).statusCode).toBe(409)
  expect((await del(`/api/rooms/${room.id}/messages/nope`)).statusCode).toBe(404)
  expect((await del(`/api/rooms/nope/messages/writing`)).statusCode).toBe(404)
  const anon = await app.inject({ method: 'DELETE', url: `/api/rooms/${room.id}/messages/writing` })
  expect(anon.statusCode).toBeGreaterThanOrEqual(400)
  expect(events().filter((event) => event.type === 'message.deleted')).toEqual([])
})

test('migration 0028 adds a nullable deleted_at to existing messages', () => {
  const columns = db.sqlite
    .prepare('SELECT name, "notnull" AS required FROM pragma_table_info(\'messages\')')
    .all()
  expect(columns).toContainEqual({ name: 'deleted_at', required: 0 })
})

function readRoomUnread(roomId: string): number {
  return db.read((sqlite) => readRoom(sqlite, roomId, new Date(scheduler.now()).toISOString()))
    .unread
}

// PLAN 5.24: edit and resend, retry.
async function ownMessage(roomId: string, text: string, extra: object = {}) {
  const response = await post(`/api/rooms/${roomId}/messages`, { text, to: ['builder'], ...extra })
  expect(response.statusCode).toBe(200)
  return PostSchema.parse(response.json()).message
}
// Finishes the reply the room queued for `parent` (the mocked startRun never attaches one).
async function finishReply(roomId: string, parentId: string, agentId = 'builder') {
  const run = db.sqlite
    .prepare('SELECT message_id FROM message_runs WHERE parent_message_id = ? AND agent_id = ?')
    .get(parentId, agentId) as { message_id: string }
  await ingest.submit({
    source: 'test',
    identity: `finish-${run.message_id}`,
    apply: ({ sqlite, now }) => {
      sqlite
        .prepare("UPDATE message_runs SET state = 'completed' WHERE message_id = ?")
        .run(run.message_id)
      return storeMessage(
        sqlite,
        {
          id: run.message_id,
          roomId,
          author: { kind: 'agent', agentId },
          to: [],
          parts: [{ kind: 'text', text: 'answer' }],
          refs: [],
          createdAt: now,
          streaming: false,
        },
        now,
      )
    },
  })
  return run.message_id
}

test('an edit replaces the original: it and its replies leave Score, the correction is a new turn (owner 2026-10-09)', async () => {
  const room = await create()
  const original = await ownMessage(room.id, 'first draft')
  const replyId = await finishReply(room.id, original.id)
  const response = await post(`/api/rooms/${room.id}/messages`, {
    text: 'better draft',
    edits: original.id,
  })
  expect(response.statusCode).toBe(200)
  const body = PostSchema.parse(response.json())
  // Recipients default to the original's.
  expect(body.message.to).toEqual(['builder'])
  expect(body.routedTo).toEqual(['builder'])
  expect(body.message.edits).toBe(original.id)
  const page = PageSchema.parse((await get(`/api/rooms/${room.id}/messages`)).json())
  expect(page.items.find((item) => item.id === original.id)).toBeUndefined()
  expect(page.items.find((item) => item.id === replyId)).toBeUndefined()
  expect(page.items.find((item) => item.id === body.message.id)?.edits).toBe(original.id)
  const deleted = events().filter((event) => event.type === 'message.deleted')
  expect(deleted.map((event) => (event.data as { messageId: string }).messageId).sort()).toEqual(
    [original.id, replyId].sort(),
  )
  // The correction is an ordinary turn.
  expect(
    db.sqlite
      .prepare('SELECT COUNT(*) AS n FROM message_runs WHERE parent_message_id = ?')
      .get(body.message.id)?.n,
  ).toBe(1)
})

test('edit validation: own, finished, undeleted, same-room, not edited twice', async () => {
  const room = await create()
  const other = await create('other')
  const original = await ownMessage(room.id, 'mine')
  const agent = await agentMessage(room.id, 'theirs')
  const edit = (edits: string, roomId = room.id) =>
    post(`/api/rooms/${roomId}/messages`, { text: 'fix', to: ['builder'], edits })
  expect((await edit('nope')).statusCode).toBe(404)
  expect((await edit(agent.id)).statusCode).toBe(400)
  expect((await edit(original.id, other.id)).statusCode).toBe(400)
  const writing = 'writing-own'
  await ingest.submit({
    source: 'test',
    identity: 'streaming-own',
    apply: ({ sqlite, now }) =>
      storeMessage(
        sqlite,
        {
          id: writing,
          roomId: room.id,
          author: { kind: 'you' },
          to: [],
          parts: [],
          refs: [],
          createdAt: now,
          streaming: true,
        },
        now,
      ),
  })
  expect((await edit(writing)).statusCode).toBe(400)
  const gone = await ownMessage(room.id, 'gone')
  expect((await del(`/api/rooms/${room.id}/messages/${gone.id}`)).statusCode).toBe(204)
  expect((await edit(gone.id)).statusCode).toBe(404)
  expect((await edit(original.id)).statusCode).toBe(200)
  // The first edit removed the original, so a second edit finds nothing to correct.
  expect((await edit(original.id)).statusCode).toBe(404)
  expect(events().filter((event) => event.type === 'message.updated')).toHaveLength(1)
})

test('retry queues a fresh turn for the same agent and input, keeps the old reply and is idempotent per key', async () => {
  const room = await create()
  const original = await ownMessage(room.id, 'do the thing')
  const replyId = await finishReply(room.id, original.id)
  const url = `/api/rooms/${room.id}/messages/${replyId}/retry`
  const first = await post(url, {}, 'retry-key-1')
  expect(first.statusCode).toBe(202)
  const { messageId } = first.json() as { messageId: string }
  expect(messageId).not.toBe(replyId)
  const rows = db.sqlite
    .prepare(
      'SELECT message_id, agent_id, input, hop, state, chain_id FROM message_runs WHERE parent_message_id = ? ORDER BY rowid',
    )
    .all(original.id)
  expect(rows).toHaveLength(2)
  expect(rows[1]).toMatchObject({
    message_id: messageId,
    agent_id: 'builder',
    hop: 0,
    state: 'pending',
  })
  expect(rows[1]!.input).toBe(rows[0]!.input)
  expect(rows[1]!.chain_id).toBe(rows[0]!.chain_id)
  // Same key: the receipt replays, no third turn.
  const again = await post(url, {}, 'retry-key-1')
  expect(again.statusCode).toBe(202)
  expect(again.json()).toEqual({ messageId })
  expect(
    db.sqlite
      .prepare('SELECT COUNT(*) AS n FROM message_runs WHERE parent_message_id = ?')
      .get(original.id)?.n,
  ).toBe(2)
  // The dispatcher admitted it through the normal path.
  expect(port.startRun).toHaveBeenCalledTimes(2)
  // Another retry while that one is still being answered is refused.
  expect((await post(url, {}, 'retry-key-2')).statusCode).toBe(409)
  // The old reply is untouched.
  const page = PageSchema.parse((await get(`/api/rooms/${room.id}/messages`)).json())
  expect(page.items.some((item) => item.id === replyId)).toBe(true)
})

test('retry refuses unknown replies, hand-offs, non-replies, a gone parent and every pause', async () => {
  const room = await create()
  const retry = (id: string, key?: string) =>
    post(`/api/rooms/${room.id}/messages/${id}/retry`, {}, key)
  expect((await retry('nope')).statusCode).toBe(404)
  const agent = await agentMessage(room.id, 'plain-agent-message')
  expect((await retry(agent.id)).statusCode).toBe(409)
  const original = await ownMessage(room.id, 'hello')
  expect((await retry(original.id)).statusCode).toBe(409)
  const replyId = await finishReply(room.id, original.id)
  db.sqlite
    .prepare('UPDATE team_state SET paused_at = ? WHERE id = 1')
    .run(new Date(scheduler.now()).toISOString())
  expect((await retry(replyId)).statusCode).toBe(409)
  db.sqlite.prepare('UPDATE team_state SET paused_at = NULL WHERE id = 1').run()
  db.sqlite
    .prepare('INSERT INTO agent_pauses (agent_id, paused_at) VALUES (?, ?)')
    .run('builder', new Date(scheduler.now()).toISOString())
  expect((await retry(replyId)).statusCode).toBe(409)
  db.sqlite.prepare('DELETE FROM agent_pauses').run()
  db.sqlite
    .prepare('UPDATE briefs SET paused_at = ? WHERE id = ?')
    .run(new Date(scheduler.now()).toISOString(), original.id)
  expect((await retry(replyId)).statusCode).toBe(409)
  db.sqlite.prepare('UPDATE briefs SET paused_at = NULL WHERE id = ?').run(original.id)
  db.sqlite
    .prepare('UPDATE message_runs SET from_agent_id = ? WHERE message_id = ?')
    .run('lead', replyId)
  expect((await retry(replyId)).statusCode).toBe(409)
  db.sqlite
    .prepare('UPDATE message_runs SET from_agent_id = NULL WHERE message_id = ?')
    .run(replyId)
  expect((await del(`/api/rooms/${room.id}/messages/${original.id}`)).statusCode).toBe(204)
  expect((await retry(replyId)).statusCode).toBe(409)
})

test('migration 0029 adds nullable edited_by and edits to messages', () => {
  const columns = db.sqlite
    .prepare('SELECT name, "notnull" AS required FROM pragma_table_info(\'messages\')')
    .all()
  expect(columns).toContainEqual({ name: 'edited_by', required: 0 })
  expect(columns).toContainEqual({ name: 'edits', required: 0 })
})
