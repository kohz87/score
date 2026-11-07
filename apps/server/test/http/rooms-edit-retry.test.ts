import { expect, test } from 'vitest'
import { storeMessage, updateMessage } from '../../src/domain/rooms.ts'
import {
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

const { get, post, create, events, agentMessage, del, ownMessage, finishReply } =
  createRoomsTestHelpers(testState)
setupRoomsTest(testState)

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
  await ingest.submit({
    source: 'test',
    identity: 'finish-own',
    apply: ({ sqlite, now }) => updateMessage(sqlite, room.id, writing, null, now),
  })
  // The queued turns of these test messages are still open: the edit would hide work in flight.
  expect((await edit(original.id)).statusCode).toBe(409)
  db.sqlite.prepare("UPDATE message_runs SET state = 'completed' WHERE room_id = ?").run(room.id)
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

test('editing a message whose turn is still queued is refused until the work is stopped (audit wave 4, 5.33)', async () => {
  const room = await create()
  const original = await ownMessage(room.id, 'obsolete instruction')
  // The mocked startRun never attaches a reply, so the turn is still queued when the edit arrives.
  expect(
    db.sqlite.prepare('SELECT state FROM message_runs WHERE parent_message_id = ?').get(original.id)
      ?.state,
  ).toBe('pending')
  const edited = await post(`/api/rooms/${room.id}/messages`, {
    text: 'new instruction',
    edits: original.id,
  })
  // An edit would hide the original and everything after it; queued work must be stopped first, so the replaced
  // instruction can never run behind the person's back.
  expect(edited.statusCode).toBe(409)
  expect(edited.json().error.message).toMatch(/queued work|stop it first/)
  expect(
    db.sqlite
      .prepare('SELECT COUNT(*) AS n FROM messages WHERE room_id = ? AND deleted_at IS NOT NULL')
      .get(room.id)?.n,
  ).toBe(0)
})

test('retry sends the original admitted input again, not the room as it is now (audit wave 4)', async () => {
  const room = await create()
  const original = await ownMessage(room.id, 'do the thing')
  const replyId = await finishReply(room.id, original.id)
  await ownMessage(room.id, 'only say CANCELLED')
  const first = (await post(`/api/rooms/${room.id}/messages/${replyId}/retry`, {}, 'k')).json() as {
    messageId: string
  }
  const rows = db.sqlite
    .prepare(
      'SELECT message_id, admission_input FROM message_runs WHERE parent_message_id = ? ORDER BY rowid',
    )
    .all(original.id) as Array<{ message_id: string; admission_input: string }>
  const retried = rows.find((row) => row.message_id === first.messageId)!
  expect(retried.admission_input).toBe(rows[0]!.admission_input)
  expect(retried.admission_input).not.toContain('CANCELLED')
})

// audit4-c 1: deleting a message must not leave its replies alive.
test('deleting a message fails its pending replies and refuses while one is streaming', async () => {
  const room = await create()
  const own = await ownMessage(room.id, 'do the thing')
  const run = db.sqlite
    .prepare('SELECT message_id FROM message_runs WHERE parent_message_id = ?')
    .get(own.id) as { message_id: string }
  // The mocked startRun leaves the turn active; put it back in the queue.
  db.sqlite
    .prepare("UPDATE message_runs SET state = 'pending' WHERE message_id = ?")
    .run(run.message_id)
  expect((await del(`/api/rooms/${room.id}/messages/${own.id}`)).statusCode).toBe(204)
  expect(
    db.sqlite.prepare('SELECT state FROM message_runs WHERE message_id = ?').get(run.message_id)
      ?.state,
  ).toBe('failed')
  // Never started: no reply message appears.
  expect(
    db.sqlite.prepare('SELECT 1 FROM messages WHERE id = ?').get(run.message_id),
  ).toBeUndefined()

  const second = await ownMessage(room.id, 'again')
  const reply = db.sqlite
    .prepare('SELECT message_id FROM message_runs WHERE parent_message_id = ?')
    .get(second.id) as { message_id: string }
  await ingest.submit({
    source: 'test',
    identity: 'stream-reply',
    apply: ({ sqlite, now }) => {
      sqlite
        .prepare("UPDATE message_runs SET state = 'active' WHERE message_id = ?")
        .run(reply.message_id)
      return storeMessage(
        sqlite,
        {
          id: reply.message_id,
          roomId: room.id,
          author: { kind: 'agent', agentId: 'builder' },
          to: [],
          parts: [],
          refs: [],
          createdAt: now,
          streaming: true,
        },
        now,
      )
    },
  })
  expect((await del(`/api/rooms/${room.id}/messages/${second.id}`)).statusCode).toBe(409)
  expect(
    db.sqlite.prepare('SELECT deleted_at FROM messages WHERE id = ?').get(second.id)?.deleted_at,
  ).toBeNull()
})

// audit4-c 6: imported copies are read-only on the server too, not just in the web app.
test('imported messages cannot be edited or rewound', async () => {
  const room = await create()
  await ingest.submit({
    source: 'test',
    identity: 'imported-own',
    apply: ({ sqlite, now }) =>
      storeMessage(
        sqlite,
        {
          id: `import:${room.id}:0`,
          roomId: room.id,
          author: { kind: 'you' },
          to: [],
          parts: [{ kind: 'text', text: 'from telegram' }],
          refs: [],
          createdAt: now,
          streaming: false,
        },
        now,
      ),
  })
  const edit = await post(`/api/rooms/${room.id}/messages`, {
    text: 'fix',
    to: ['builder'],
    edits: `import:${room.id}:0`,
  })
  expect(edit.statusCode).toBe(400)
  const plan = await get(
    `/api/rooms/${room.id}/messages/${encodeURIComponent(`import:${room.id}:0`)}/rewind-plan`,
  )
  expect(plan.statusCode).toBe(400)
})
