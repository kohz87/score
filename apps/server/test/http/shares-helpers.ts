import { RoomSchema, type Message } from '@score/contract'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, vi } from 'vitest'
import { buildApp } from '../../src/app.ts'
import { SecurityPassword } from '../../src/auth/security-password.ts'
import { loadConfig } from '../../src/config.ts'
import { migrate, openDatabase, type ScoreDb } from '../../src/db/index.ts'
import { storeMessage } from '../../src/domain/rooms.ts'
import { createHermesPort, type HermesPort } from '../../src/hermes/index.ts'
import { createIngest, type Ingest } from '../../src/hub/ingest.ts'
import { FakeScheduler } from '../hermes/fake-scheduler.ts'

export const PASSWORD = 'correct horse battery'
export const DAY = 24 * 60 * 60 * 1000

export type SharesTestState = {
  dir: string
  db: ScoreDb
  ingest: Ingest
  port: HermesPort
  scheduler: FakeScheduler
  app: ReturnType<typeof buildApp>
  headers: { 'x-score-client': string; cookie: string }
  counter: number
}

export async function startSharesTest(): Promise<SharesTestState> {
  const dir = mkdtempSync(join(tmpdir(), 'score-shares-'))
  const db = openDatabase(join(dir, 'score.db'))
  migrate(db, fileURLToPath(new URL('../../migrations/', import.meta.url)))
  const scheduler = new FakeScheduler()
  const clock = () => scheduler.now()
  const ingest = createIngest(db, { clock })
  const port = createHermesPort(loadConfig({ SCORE_MODE: 'fake', SCORE_FAKE_LOOP: 'false' }), {
    db,
    scheduler,
  })
  const app = buildApp({
    config: loadConfig({ SCORE_MODE: 'fake' }),
    logger: false,
    db,
    ingest,
    port,
    clock,
    security: new SecurityPassword(dir, clock),
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
  vi.spyOn(port, 'startRun').mockResolvedValue({ runId: 'share-run' })
  return { dir, db, ingest, port, scheduler, app, headers, counter: 0 }
}

export async function stopSharesTest(state: SharesTestState) {
  vi.restoreAllMocks()
  await state.port.stop()
  await state.app.close()
  await state.ingest.close()
  state.db.close()
  rmSync(state.dir, { recursive: true, force: true })
}

export function sharesTestSuite(
  assign: (state: SharesTestState) => void,
  current: () => SharesTestState,
) {
  beforeEach(async () => assign(await startSharesTest()))
  afterEach(async () => stopSharesTest(current()))
}

export function createSharesHelpers(current: () => SharesTestState) {
  async function setPassword() {
    const response = await current().app.inject({
      method: 'PUT',
      url: '/api/session/security/password',
      headers: current().headers,
      payload: { password: PASSWORD },
    })
    expect(response.statusCode).toBe(204)
  }
  async function room(name = 'shared') {
    const response = await current().app.inject({
      method: 'POST',
      url: '/api/rooms',
      headers: current().headers,
      payload: { name, leadAgentId: 'lead', members: ['lead', 'builder'] },
    })
    return RoomSchema.parse(response.json())
  }
  async function say(roomId: string, parts: Message['parts'], you = false) {
    const state = current()
    const message: Message = {
      id: `s-${++state.counter}`,
      roomId,
      author: you ? { kind: 'you' } : { kind: 'agent', agentId: 'builder' },
      to: [],
      parts,
      refs: [],
      createdAt: new Date(state.scheduler.now() + state.counter * 1000).toISOString(),
      streaming: false,
    }
    await state.ingest.submit({
      source: 'test',
      identity: `say-${state.counter}`,
      apply: ({ sqlite, now }) => storeMessage(sqlite, message, now),
    })
    return message
  }
  const create = (roomId: string, payload: object = {}, withHeaders = current().headers) =>
    current().app.inject({
      method: 'POST',
      url: `/api/rooms/${roomId}/shares`,
      headers: withHeaders,
      payload: { password: PASSWORD, ...payload },
    })
  const tokenOf = (url: string) => url.split('/s/')[1]!
  const page = (token: string, remoteAddress?: string) =>
    current().app.inject({ url: `/s/${token}`, ...(remoteAddress ? { remoteAddress } : {}) })
  return { setPassword, room, say, create, tokenOf, page }
}
