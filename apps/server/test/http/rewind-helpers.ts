import { MessageSchema, RoomSchema, StreamEventSchema } from '@score/contract'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, vi } from 'vitest'
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
export const PostSchema = z.object({ message: MessageSchema })

let dir: string
export let db: ScoreDb
let ingest: Ingest
export let port: HermesPort
let scheduler: FakeScheduler
let app: ReturnType<typeof buildApp>
let headers: { 'x-score-client': string; cookie: string }

export function setupRewindTest() {
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
}

export const fake = () => port as unknown as FakePort
export const get = (url: string) => app.inject({ method: 'GET', url })
export const post = (url: string, payload: object, key?: string) =>
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
export async function createRoom() {
  const response = await post('/api/rooms', {
    name: 'team',
    leadAgentId: 'lead',
    members: ['lead', 'builder', 'reviewer'],
  })
  expect(response.statusCode).toBe(200)
  return RoomSchema.parse(response.json())
}
export function events() {
  return db.sqlite
    .prepare('SELECT seq, ts, type, data FROM events ORDER BY seq')
    .all()
    .map((row) =>
      StreamEventSchema.parse({ ...row, data: JSON.parse(String(row.data)) as unknown }),
    )
}
export async function ask(roomId: string, text: string, to: string[], extra: object = {}) {
  await tick()
  const response = await post(`/api/rooms/${roomId}/messages`, { text, to, ...extra })
  expect(response.statusCode).toBe(200)
  const message = PostSchema.parse(response.json()).message
  await tick()
  return message
}
// Finishes the turn the room queued for `parent` the way a Hermes run would: the reply exists and the turn is done.
export async function answer(
  roomId: string,
  parentId: string,
  agentId: string,
  fromAgent?: string,
) {
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
export async function extraTurn(roomId: string, parentId: string, agentId: string, hop = 1) {
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
export const rewind = (roomId: string, messageId: string, body: object = { mode: 'delete' }) =>
  post(`/api/rooms/${roomId}/messages/${messageId}/rewind`, body)
export const visible = async (roomId: string) =>
  PageSchema.parse((await get(`/api/rooms/${roomId}/messages`)).json()).items.map((m) => m.id)
