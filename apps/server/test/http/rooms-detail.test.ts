import { type Message } from '@score/contract'
import { expect, test } from 'vitest'
import { z } from 'zod'
import { storeMessage, updateMessage } from '../../src/domain/rooms.ts'
import {
  DetailSchema,
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

const { get, create, agentMessage } = createRoomsTestHelpers(testState)
setupRoomsTest(testState)

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
