import { RoomSchema, StreamEventSchema, type Message } from '@score/contract'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, vi } from 'vitest'
import { buildApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { migrate, openDatabase, type ScoreDb } from '../../src/db/index.ts'
import { messageFromRow } from '../../src/domain/rooms.ts'
import { FakePort } from '../../src/hermes/fake/fake-port.ts'
import { createIngest, type Ingest } from '../../src/hub/ingest.ts'
import { FakeScheduler } from '../hermes/fake-scheduler.ts'
import { onMentions } from '../helpers/on-mentions.ts'

export type RoutingTestState = {
  dir: string
  db: ScoreDb
  ingest: Ingest
  port: FakePort
  scheduler: FakeScheduler
  app: ReturnType<typeof buildApp>
  headers: { 'x-score-client': string; cookie: string }
  roomId: string
  replies: Record<string, string>
}

export async function startRoutingTest(): Promise<RoutingTestState> {
  const dir = mkdtempSync(join(tmpdir(), 'score-routing-'))
  const db = openDatabase(join(dir, 'score.db'))
  migrate(db, fileURLToPath(new URL('../../migrations/', import.meta.url)))
  const scheduler = new FakeScheduler()
  const clock = () => scheduler.now()
  const ingest = createIngest(db, { clock })
  const replies: Record<string, string> = {}
  const port = new FakePort(1, { db, scheduler }, false, (req) => ({
    text: replies[req.agentId] ?? 'The streamed reply is ready.',
    tools: ['terminal', 'terminal', 'terminal', 'edit_file', 'edit_file'],
  }))
  await port.start(ingest)
  const app = buildApp({
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
  const headers = {
    'x-score-client': 'web',
    cookie: paired.headers['set-cookie']!.toString().split(';')[0]!,
  }
  const created = await app.inject({
    method: 'POST',
    url: '/api/rooms',
    headers,
    payload: { name: 'routing', leadAgentId: 'lead' },
  })
  const roomId = RoomSchema.parse(created.json()).id
  onMentions(db, roomId)
  return { dir, db, ingest, port, scheduler, app, headers, roomId, replies }
}

export async function stopRoutingTest(state: RoutingTestState) {
  await state.port.stop()
  await state.app.close()
  await state.ingest.close()
  state.db.close()
  rmSync(state.dir, { recursive: true, force: true })
  vi.restoreAllMocks()
}

export function routingTestSuite(
  assign: (state: RoutingTestState) => void,
  current: () => RoutingTestState,
) {
  beforeEach(async () => assign(await startRoutingTest()))
  afterEach(async () => stopRoutingTest(current()))
}

export function createRoutingHelpers(current: () => RoutingTestState) {
  const post = (url: string, payload: object, key?: string) =>
    current().app.inject({
      method: 'POST',
      url,
      headers: { ...current().headers, ...(key ? { 'idempotency-key': key } : {}) },
      payload,
    })
  const send = (payload: object, key?: string) =>
    post(`/api/rooms/${current().roomId}/messages`, payload, key)
  const messages = (): Message[] =>
    current().db.read((sqlite) =>
      sqlite
        .prepare('SELECT * FROM messages WHERE room_id = ?')
        .all(current().roomId)
        .map(messageFromRow),
    )
  const events = () =>
    current()
      .db.sqlite.prepare('SELECT * FROM events ORDER BY seq')
      .all()
      .map((row) =>
        StreamEventSchema.parse({ ...row, data: JSON.parse(String(row.data)) as unknown }),
      )
  async function advance(ms: number) {
    const state = current()
    await state.scheduler.advance(ms)
    await state.ingest.flushListeners()
    await state.ingest.drain()
  }
  return { post, send, messages, events, advance }
}
