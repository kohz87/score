import { MessageSchema, RoomSchema, StreamEventSchema, type Message } from '@score/contract'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, vi } from 'vitest'
import { z } from 'zod'
import { buildApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { migrate, openDatabase, type ScoreDb } from '../../src/db/index.ts'
import { readRoom, storeMessage } from '../../src/domain/rooms.ts'
import { createHermesPort, type HermesPort } from '../../src/hermes/index.ts'
import { createIngest, type Ingest } from '../../src/hub/ingest.ts'
import { FakeScheduler } from '../hermes/fake-scheduler.ts'

export type RoomsTestState = {
  dir: string
  db: ScoreDb
  ingest: Ingest
  port: HermesPort
  scheduler: FakeScheduler
  app: ReturnType<typeof buildApp>
  headers: { 'x-score-client': string; cookie: string }
  counter: number
}

export const ListSchema = z.object({
  asOfSeq: z.int().nonnegative(),
  rooms: z.array(RoomSchema),
  directs: z.array(RoomSchema),
})
export const DetailSchema = z.object({
  asOfSeq: z.int().nonnegative(),
  room: RoomSchema,
  filesInPlay: z.array(z.string()),
  learned: z.array(
    z.object({ text: z.string(), savedTo: z.array(z.string()), at: z.iso.datetime() }),
  ),
})
export const PageSchema = z.object({
  asOfSeq: z.int().nonnegative(),
  items: z.array(MessageSchema),
  nextCursor: z.string().nullable(),
})
export const PostSchema = z.object({
  message: MessageSchema,
  routedTo: z.array(z.string()),
  command: z.null(),
})

export function setupRoomsTest(state: RoomsTestState) {
  beforeEach(async () => {
    state.dir = mkdtempSync(join(tmpdir(), 'score-rooms-'))
    state.db = openDatabase(join(state.dir, 'score.db'))
    migrate(state.db, fileURLToPath(new URL('../../migrations/', import.meta.url)))
    state.scheduler = new FakeScheduler()
    const clock = () => state.scheduler.now()
    state.ingest = createIngest(state.db, { clock })
    state.port = createHermesPort(loadConfig({ SCORE_MODE: 'fake', SCORE_FAKE_LOOP: 'false' }), {
      db: state.db,
      scheduler: state.scheduler,
    })
    state.app = buildApp({
      config: loadConfig({ SCORE_MODE: 'fake' }),
      logger: false,
      db: state.db,
      ingest: state.ingest,
      port: state.port,
      clock,
    })
    const paired = await state.app.inject({
      method: 'POST',
      url: '/api/session/pair',
      headers: { 'x-score-client': 'web' },
      payload: { token: state.app.pairing.createToken() },
    })
    state.headers = {
      'x-score-client': 'web',
      cookie: paired.headers['set-cookie']!.toString().split(';')[0]!,
    }
    state.counter = 0
    vi.spyOn(state.port, 'startRun').mockResolvedValue({ runId: 'room-test-run' })
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    await state.port.stop()
    await state.app.close()
    await state.ingest.close()
    state.db.close()
    rmSync(state.dir, { recursive: true, force: true })
  })
}

export function createRoomsTestHelpers(state: RoomsTestState) {
  const get = (url: string) => state.app.inject({ method: 'GET', url })
  const post = (url: string, payload: object, key?: string) =>
    state.app.inject({
      method: 'POST',
      url,
      headers: { ...state.headers, ...(key ? { 'idempotency-key': key } : {}) },
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
    return state.db.sqlite
      .prepare('SELECT seq, ts, type, data FROM events ORDER BY seq')
      .all()
      .map((row) =>
        StreamEventSchema.parse({ ...row, data: JSON.parse(String(row.data)) as unknown }),
      )
  }
  async function agentMessage(
    roomId: string,
    id = `agent-${++state.counter}`,
    agentId = 'builder',
  ) {
    const message: Message = {
      id,
      roomId,
      author: { kind: 'agent', agentId },
      to: [],
      parts: [{ kind: 'text', text: id }],
      refs: [],
      createdAt: new Date(state.scheduler.now()).toISOString(),
      streaming: false,
    }
    await state.ingest.submit({
      source: 'test',
      identity: `message-${state.counter}-${id}`,
      apply: ({ sqlite, now }) => storeMessage(sqlite, message, now),
    })
    return message
  }
  const del = (url: string, key?: string) =>
    state.app.inject({
      method: 'DELETE',
      url,
      headers: { ...state.headers, ...(key ? { 'idempotency-key': key } : {}) },
    })
  function readRoomUnread(roomId: string): number {
    return state.db.read((sqlite) =>
      readRoom(sqlite, roomId, new Date(state.scheduler.now()).toISOString()),
    ).unread
  }
  // PLAN 5.24: edit and resend, retry.
  async function ownMessage(roomId: string, text: string, extra: object = {}) {
    const response = await post(`/api/rooms/${roomId}/messages`, {
      text,
      to: ['builder'],
      ...extra,
    })
    expect(response.statusCode).toBe(200)
    return PostSchema.parse(response.json()).message
  }
  // Finishes the reply the room queued for `parent` (the mocked startRun never attaches one).
  async function finishReply(roomId: string, parentId: string, agentId = 'builder') {
    const run = state.db.sqlite
      .prepare('SELECT message_id FROM message_runs WHERE parent_message_id = ? AND agent_id = ?')
      .get(parentId, agentId) as { message_id: string }
    await state.ingest.submit({
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

  return { get, post, create, events, agentMessage, del, readRoomUnread, ownMessage, finishReply }
}
