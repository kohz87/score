import {
  MessageSchema,
  RewindPlanSchema,
  RewindResponseSchema,
  RoomSchema,
  RoomVersionDetailSchema,
  RoomVersionsSchema,
  StreamEventSchema,
} from '@score/contract'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { z } from 'zod'
import { buildApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { migrate, openDatabase, type ScoreDb } from '../../src/db/index.ts'
import { storeMessage } from '../../src/domain/rooms.ts'
import { createHermesPort, type HermesPort } from '../../src/hermes/index.ts'
import { createIngest, type Ingest } from '../../src/hub/ingest.ts'
import { FakeScheduler } from '../hermes/fake-scheduler.ts'
import type { FakePort } from '../../src/hermes/fake/fake-port.ts'

const PageSchema = z.object({
  asOfSeq: z.int().nonnegative(),
  items: z.array(MessageSchema),
  nextCursor: z.string().nullable(),
})
const PostSchema = z.object({ message: MessageSchema })

let dir: string
let db: ScoreDb
let ingest: Ingest
let port: HermesPort
let scheduler: FakeScheduler
let app: ReturnType<typeof buildApp>
let headers: { 'x-score-client': string; cookie: string }

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'score-rewind-'))
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
  vi.spyOn(port, 'startRun').mockResolvedValue({ runId: 'rewind-test-run' })
})
afterEach(async () => {
  vi.restoreAllMocks()
  await port.stop()
  await app.close()
  await ingest.close()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})
const fake = () => port as unknown as FakePort
const get = (url: string) => app.inject({ method: 'GET', url })
const post = (url: string, payload: object, key?: string) =>
  app.inject({
    method: 'POST',
    url,
    headers: { ...headers, ...(key ? { 'idempotency-key': key } : {}) },
    payload,
  })
// A turn Hermes ran has a run row (message_runs.run_id references it).
function hermesRun(sqlite: import('node:sqlite').DatabaseSync, id: string, now: string) {
  sqlite
    .prepare(
      `INSERT OR IGNORE INTO runs (id, profile, origin, status, started_at, updated_at) VALUES (?, 'builder', 'score', 'completed', ?, ?)`,
    )
    .run(id, now, now)
}
async function tick() {
  await scheduler.advance(10)
}
async function createRoom() {
  const response = await post('/api/rooms', {
    name: 'team',
    leadAgentId: 'lead',
    members: ['lead', 'builder', 'reviewer'],
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
async function ask(roomId: string, text: string, to: string[], extra: object = {}) {
  await tick()
  const response = await post(`/api/rooms/${roomId}/messages`, { text, to, ...extra })
  expect(response.statusCode).toBe(200)
  const message = PostSchema.parse(response.json()).message
  await tick()
  return message
}
// Finishes the turn the room queued for `parent` the way a Hermes run would: the reply exists and the turn is done.
async function answer(roomId: string, parentId: string, agentId: string, fromAgent?: string) {
  const run = db.sqlite
    .prepare('SELECT message_id FROM message_runs WHERE parent_message_id = ? AND agent_id = ?')
    .get(parentId, agentId) as { message_id: string }
  await tick()
  await ingest.submit({
    source: 'test',
    identity: `finish-${run.message_id}`,
    apply: ({ sqlite, now }) => {
      hermesRun(sqlite, `run-${run.message_id}`, now)
      sqlite
        .prepare(
          "UPDATE message_runs SET state = 'completed', from_agent_id = ?, run_id = ? WHERE message_id = ?",
        )
        .run(fromAgent ?? null, `run-${run.message_id}`, run.message_id)
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
  await tick()
  return run.message_id
}
// A second turn of the same agent for the same message (a retry or a hand-off) with its own reply.
async function extraTurn(roomId: string, parentId: string, agentId: string, hop = 1) {
  await tick()
  const id = `reply:extra-${parentId}-${agentId}-${hop}-${Math.random()}`
  await ingest.submit({
    source: 'test',
    identity: id,
    apply: ({ sqlite, now }) => {
      hermesRun(sqlite, `run-${id}`, now)
      sqlite
        .prepare(
          `INSERT INTO message_runs (message_id, room_id, agent_id, chain_id, hop, turn_id, parent_message_id, input, agents, state, created_at, run_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'x', '[]', 'completed', ?, ?)`,
        )
        .run(id, roomId, agentId, parentId, hop, `turn-${id}`, parentId, now, `run-${id}`)
      return storeMessage(
        sqlite,
        {
          id,
          roomId,
          author: { kind: 'agent', agentId },
          to: [],
          parts: [{ kind: 'text', text: 'again' }],
          refs: [],
          createdAt: now,
          streaming: false,
        },
        now,
      )
    },
  })
  await tick()
  return id
}
const rewind = (roomId: string, messageId: string, body: object = { mode: 'delete' }) =>
  post(`/api/rooms/${roomId}/messages/${messageId}/rewind`, body)
const visible = async (roomId: string) =>
  PageSchema.parse((await get(`/api/rooms/${roomId}/messages`)).json()).items.map((m) => m.id)

test("a rewind counts each agent's turns from the message on (hand-offs, retries), hides the rest as a version and asks Hermes once", async () => {
  const room = await createRoom()
  const first = await ask(room.id, 'first', ['builder'])
  await answer(room.id, first.id, 'builder')
  const second = await ask(room.id, 'second', ['builder', 'reviewer'])
  const builderReply = await answer(room.id, second.id, 'builder')
  const reviewerReply = await answer(room.id, second.id, 'reviewer')
  const retry = await extraTurn(room.id, second.id, 'builder')
  const handoff = await extraTurn(room.id, second.id, 'lead', 2)
  const rewinds = vi.spyOn(fake(), 'rewindSession')

  const plan = RewindPlanSchema.parse(
    (await get(`/api/rooms/${room.id}/messages/${second.id}/rewind-plan`)).json(),
  )
  expect(plan).toEqual({
    hiddenCount: 5,
    blocked: null,
    agents: [
      { agentId: 'builder', turns: 2, cannot: null },
      { agentId: 'lead', turns: 1, cannot: null },
      { agentId: 'reviewer', turns: 1, cannot: null },
    ],
  })
  rewinds.mockClear()
  const response = await rewind(room.id, second.id)
  expect(response.statusCode).toBe(200)
  const body = RewindResponseSchema.parse(response.json())
  expect(body.rewound).toEqual([
    { agentId: 'builder', turnsUndone: 2 },
    { agentId: 'lead', turnsUndone: 1 },
    { agentId: 'reviewer', turnsUndone: 1 },
  ])
  expect(body.skipped).toEqual([])
  expect(body.version).toMatchObject({
    anchorId: second.id,
    mode: 'delete',
    hiddenCount: 5,
    number: 1,
    count: 1,
    replacedBy: null,
  })
  expect(
    rewinds.mock.calls
      .filter(([call]) => !call.dryRun)
      .map(([call]) => [call.agentId, call.sessionId, call.turns]),
  ).toEqual([
    ['builder', `score-${room.id}-builder`, 2],
    ['lead', `score-${room.id}-lead`, 1],
    ['reviewer', `score-${room.id}-reviewer`, 1],
  ])
  // Everything from the message on is gone from the room; the first exchange stays.
  expect(await visible(room.id)).toHaveLength(2)
  const types = events().map((event) => event.type)
  expect(types.filter((type) => type === 'message.deleted')).toHaveLength(5)
  expect(types.indexOf('room.version.created')).toBeGreaterThan(
    types.lastIndexOf('message.deleted'),
  )

  const detail = RoomVersionDetailSchema.parse(
    (await get(`/api/rooms/${room.id}/versions/${second.id}`)).json(),
  )
  expect(detail.items.map((item) => item.id)).toEqual([
    second.id,
    builderReply,
    reviewerReply,
    retry,
    handoff,
  ])
  const list = RoomVersionsSchema.parse((await get(`/api/rooms/${room.id}/versions`)).json())
  expect(list.items.map((item) => item.anchorId)).toEqual([second.id])
  expect((await get(`/api/rooms/${room.id}/versions/nope`)).statusCode).toBe(404)

  // Idempotent: repeating returns the stored result and never asks Hermes again.
  rewinds.mockClear()
  const again = await rewind(room.id, second.id)
  expect(again.statusCode).toBe(200)
  expect(RewindResponseSchema.parse(again.json()).version.id).toBe(body.version.id)
  expect(rewinds.mock.calls.filter(([call]) => !call.dryRun)).toEqual([])
  expect(events().filter((event) => event.type === 'room.version.created')).toHaveLength(1)

  // The turns already rewound are not counted by a later rewind of an earlier message.
  const earlier = await rewind(room.id, first.id)
  expect(RewindResponseSchema.parse(earlier.json()).rewound).toEqual([
    { agentId: 'builder', turnsUndone: 1 },
  ])
})

test('nothing is hidden unless every rewind worked; Hide in Score only skips Hermes', async () => {
  const room = await createRoom()
  const message = await ask(room.id, 'go', ['builder', 'reviewer'])
  await answer(room.id, message.id, 'builder')
  await answer(room.id, message.id, 'reviewer')
  fake().rewindSkips.set('reviewer', 'compressed')
  const plan = RewindPlanSchema.parse(
    (await get(`/api/rooms/${room.id}/messages/${message.id}/rewind-plan`)).json(),
  )
  expect(plan.agents.map((agent) => [agent.agentId, agent.cannot])).toEqual([
    ['builder', null],
    ['reviewer', 'compressed'],
  ])
  const refused = await rewind(room.id, message.id)
  expect(refused.statusCode).toBe(409)
  expect(refused.json()).toMatchObject({
    error: {
      code: 'rewind_incomplete',
      details: { skipped: [{ agentId: 'reviewer', reason: 'compressed' }], rewound: [] },
    },
  })
  expect(await visible(room.id)).toHaveLength(3)
  expect(fake().rewinds).toEqual([])

  const scoreOnly = await rewind(room.id, message.id, { mode: 'delete', scoreOnly: true })
  expect(scoreOnly.statusCode).toBe(200)
  expect(RewindResponseSchema.parse(scoreOnly.json())).toMatchObject({
    rewound: [],
    skipped: [
      { agentId: 'builder', reason: 'score_only' },
      { agentId: 'reviewer', reason: 'score_only' },
    ],
  })
  expect(fake().rewinds).toEqual([])
  expect(await visible(room.id)).toHaveLength(0)
})

test('a failure after the first agent keeps it rewound and counted once on retry', async () => {
  const room = await createRoom()
  const message = await ask(room.id, 'go', ['builder', 'reviewer'])
  await answer(room.id, message.id, 'builder')
  await answer(room.id, message.id, 'reviewer')
  const real = fake().rewindSession.bind(fake())
  vi.spyOn(fake(), 'rewindSession').mockImplementation(async (req) =>
    req.agentId === 'reviewer' && !req.dryRun
      ? { status: 'skipped', reason: 'no_answer' }
      : real(req),
  )
  const failed = await rewind(room.id, message.id)
  expect(failed.statusCode).toBe(409)
  expect(failed.json()).toMatchObject({
    error: {
      code: 'rewind_incomplete',
      details: {
        skipped: [{ agentId: 'reviewer', reason: 'no_answer' }],
        rewound: [{ agentId: 'builder', turnsUndone: 1 }],
      },
    },
  })
  expect(await visible(room.id)).toHaveLength(3)
  vi.mocked(fake().rewindSession).mockImplementation(real)
  fake().rewinds.length = 0
  const retried = await rewind(room.id, message.id)
  expect(retried.statusCode).toBe(200)
  // Builder was rewound before and has nothing left to undo.
  expect(fake().rewinds.map((item) => item.agentId)).toEqual(['reviewer'])
})

test("a rewind is refused while an agent is answering or work is queued, and for other people's messages", async () => {
  const room = await createRoom()
  const message = await ask(room.id, 'go', ['builder'])
  const queued = await rewind(room.id, message.id)
  expect(queued.statusCode).toBe(409)
  expect(
    (await get(`/api/rooms/${room.id}/messages/${message.id}/rewind-plan`)).json(),
  ).toMatchObject({ blocked: expect.stringContaining('answering') })
  const reply = await answer(room.id, message.id, 'builder')
  expect((await rewind(room.id, reply)).statusCode).toBe(400)
  expect((await rewind(room.id, 'nope')).statusCode).toBe(404)
  expect((await rewind(room.id, message.id, { mode: 'x' })).statusCode).toBe(400)
  db.sqlite.exec('UPDATE team_state SET paused_at = datetime()')
  db.sqlite.exec("UPDATE message_runs SET state = 'pending'")
  expect(
    (await get(`/api/rooms/${room.id}/messages/${message.id}/rewind-plan`)).json(),
  ).toMatchObject({ blocked: expect.stringContaining('paused') })
})

test('an edit rewinds first, then the correction links to the version; editing again continues the chain', async () => {
  const room = await createRoom()
  const original = await ask(room.id, 'one', ['builder'])
  await answer(room.id, original.id, 'builder')
  expect((await rewind(room.id, original.id, { mode: 'edit' })).statusCode).toBe(200)
  expect(await visible(room.id)).toEqual([])
  const corrected = await post(`/api/rooms/${room.id}/messages`, {
    text: 'two',
    to: ['builder'],
    edits: original.id,
  })
  expect(corrected.statusCode).toBe(200)
  const edit = PostSchema.parse(corrected.json()).message
  expect(edit.edits).toBe(original.id)
  expect(await visible(room.id)).toEqual([edit.id])
  expect(fake().rewinds).toHaveLength(1)
  const versions = RoomVersionsSchema.parse((await get(`/api/rooms/${room.id}/versions`)).json())
  expect(versions.items[0]).toMatchObject({
    anchorId: original.id,
    replacedBy: edit.id,
    number: 1,
    count: 2,
  })
  expect(events().filter((event) => event.type === 'message.updated')).toHaveLength(1)

  await answer(room.id, edit.id, 'builder')
  expect((await rewind(room.id, edit.id, { mode: 'edit' })).statusCode).toBe(200)
  const third = PostSchema.parse(
    (
      await post(`/api/rooms/${room.id}/messages`, {
        text: 'three',
        to: ['builder'],
        edits: edit.id,
      })
    ).json(),
  ).message
  const chain = RoomVersionsSchema.parse((await get(`/api/rooms/${room.id}/versions`)).json())
  expect(chain.items.map((item) => [item.anchorId, item.number, item.count])).toEqual([
    [edit.id, 2, 3],
    [original.id, 1, 3],
  ])
  expect(chain.items[0]!.replacedBy).toBe(third.id)
})

test('an edit without a rewind hides the original and what follows in Score only', async () => {
  const room = await createRoom()
  const original = await ask(room.id, 'one', ['builder'])
  const reply = await answer(room.id, original.id, 'builder')
  const edit = PostSchema.parse(
    (
      await post(`/api/rooms/${room.id}/messages`, {
        text: 'two',
        to: ['builder'],
        edits: original.id,
      })
    ).json(),
  ).message
  expect(await visible(room.id)).toEqual([edit.id])
  expect(fake().rewinds).toEqual([])
  const detail = RoomVersionDetailSchema.parse(
    (await get(`/api/rooms/${room.id}/versions/${original.id}`)).json(),
  )
  expect(detail.items.map((item) => item.id)).toEqual([original.id, reply])
  expect(detail.version.skipped).toEqual([{ agentId: 'builder', reason: 'score_only' }])
})

test('migration 0036 adds versions, the message version link and the run rewind mark', () => {
  const columns = (table: string) =>
    (db.sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (column) => column.name,
    )
  expect(columns('room_versions')).toEqual(
    expect.arrayContaining(['anchor_id', 'mode', 'score_only', 'hidden_count', 'replaced_by']),
  )
  expect(columns('messages')).toContain('version_id')
  expect(columns('message_runs')).toContain('rewound_at')
})

// audit4-c 4: a turn that never reached Hermes (no run id) is not a turn to rewind.
test('turns that never reached Hermes are not counted in the rewind plan', async () => {
  const room = await createRoom()
  const first = await ask(room.id, 'first', ['builder'])
  await answer(room.id, first.id, 'builder')
  const second = await ask(room.id, 'second', ['builder'])
  const reply = await answer(room.id, second.id, 'builder')
  const before = RewindPlanSchema.parse(
    (await get(`/api/rooms/${room.id}/messages/${second.id}/rewind-plan`)).json(),
  )
  expect(before.agents.map((a) => [a.agentId, a.turns])).toEqual([['builder', 1]])
  // The same turn failed before Hermes ever saw it.
  db.sqlite.prepare('UPDATE message_runs SET run_id = NULL WHERE message_id = ?').run(reply)
  const after = RewindPlanSchema.parse(
    (await get(`/api/rooms/${room.id}/messages/${second.id}/rewind-plan`)).json(),
  )
  expect(after.agents).toEqual([])
})
