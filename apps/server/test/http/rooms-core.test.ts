import { RoomSchema, type Message } from '@score/contract'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { buildApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { openDatabase } from '../../src/db/index.ts'
import { storeMessage, updateMessage } from '../../src/domain/rooms.ts'
import { createIngest } from '../../src/hub/ingest.ts'
import {
  DetailSchema,
  ListSchema,
  PageSchema,
  PostSchema,
  createRoomsTestHelpers,
  setupRoomsTest,
  type RoomsTestState,
} from './rooms-helpers.ts'

let dir: RoomsTestState['dir']
let db: RoomsTestState['db']
let ingest: RoomsTestState['ingest']
let port: RoomsTestState['port']
let scheduler: RoomsTestState['scheduler']
let app: RoomsTestState['app']
let headers: RoomsTestState['headers']
const testState: RoomsTestState = {
  get dir() {
    return dir
  },
  set dir(value) {
    dir = value
  },
  get db() {
    return db
  },
  set db(value) {
    db = value
  },
  get ingest() {
    return ingest
  },
  set ingest(value) {
    ingest = value
  },
  get port() {
    return port
  },
  set port(value) {
    port = value
  },
  get scheduler() {
    return scheduler
  },
  set scheduler(value) {
    scheduler = value
  },
  get app() {
    return app
  },
  set app(value) {
    app = value
  },
  get headers() {
    return headers
  },
  set headers(value) {
    headers = value
  },
  counter: 0,
}

const { get, post, create, events, agentMessage } = createRoomsTestHelpers(testState)
setupRoomsTest(testState)

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

test('read marker persists across reopen', async () => {
  const room = await create()
  await agentMessage(room.id)
  await agentMessage(room.id, 'review', 'reviewer')
  expect(DetailSchema.parse((await get(`/api/rooms/${room.id}`)).json()).room.activeAgents).toEqual(
    [],
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
    // The room routes with exchanges (11.11): its job.upserted events, once each despite the replayed requests.
    'job.upserted',
    'job.upserted',
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
