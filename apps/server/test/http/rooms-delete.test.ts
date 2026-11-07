import { type Message } from '@score/contract'
import { expect, test } from 'vitest'
import { storeMessage } from '../../src/domain/rooms.ts'
import {
  PageSchema,
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

const { get, create, agentMessage, del, events, readRoomUnread } = createRoomsTestHelpers(testState)
setupRoomsTest(testState)

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
