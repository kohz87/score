import { type Message } from '@score/contract'
import { expect, test, vi } from 'vitest'
import { storeMessage } from '../../src/domain/rooms.ts'
import { stepToObservation } from '../../src/hermes/fake/fake-port.ts'
import { createScenario, scenarioDuration } from '../../src/hermes/fake/scenario.ts'
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

test('fake scenario persists full conversation, deltas, completion and unread via the API', async () => {
  await port.start(ingest)
  await scheduler.advance(scenarioDuration)
  const list = ListSchema.parse((await get('/api/rooms')).json())
  const room = list.rooms.find((room) => room.id === 'room-activity-feed')!
  expect(room).toMatchObject({
    name: '#activity-feed',
    unread: 4,
    activeAgents: ['designer'],
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
