import { RoomSchema, type Message } from '@score/contract'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { buildApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { migrate, openDatabase, type ScoreDb } from '../../src/db/index.ts'
import { FakePort } from '../../src/hermes/fake/fake-port.ts'
import { createIngest, type Ingest } from '../../src/hub/ingest.ts'
import { FakeScheduler } from '../hermes/fake-scheduler.ts'
import { messageFromRow } from '../../src/domain/rooms.ts'
import { onMentions } from '../helpers/on-mentions.ts'

let dir: string
let db: ScoreDb
let ingest: Ingest
let port: FakePort
let scheduler: FakeScheduler
let app: ReturnType<typeof buildApp>
let headers: { 'x-score-client': string; cookie: string }
let roomId: string
let replies: Record<string, string>

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'score-another-'))
  db = openDatabase(join(dir, 'score.db'))
  migrate(db, fileURLToPath(new URL('../../migrations/', import.meta.url)))
  scheduler = new FakeScheduler()
  const clock = () => scheduler.now()
  ingest = createIngest(db, { clock })
  replies = {}
  port = new FakePort(1, { db, scheduler }, false, (req) => ({
    text: replies[req.agentId] ?? 'The streamed reply is ready.',
    tools: ['terminal', 'terminal', 'terminal', 'edit_file', 'edit_file'],
  }))
  await port.start(ingest)
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
  const created = await post('/api/rooms', { name: 'routing', leadAgentId: 'lead' })
  roomId = RoomSchema.parse(created.json()).id
  onMentions(db, roomId)
})
afterEach(async () => {
  await port.stop()
  await app.close()
  await ingest.close()
  db.close()
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})
const post = (url: string, payload: object) => app.inject({ method: 'POST', url, headers, payload })
const messages = (): Message[] =>
  db.read((sqlite) =>
    sqlite
      .prepare('SELECT * FROM messages WHERE room_id = ? ORDER BY created_at, rowid')
      .all(roomId)
      .map(messageFromRow),
  )
async function advance(ms: number) {
  for (let i = 0; i < 10; i++) {
    await scheduler.advance(ms / 10)
    await ingest.flushListeners()
    await ingest.drain()
  }
}

// 2.4.0 (decision 130): Try another reply.
test('Try another asks the agent for a different answer and links every version to the first reply', async () => {
  const run = vi.spyOn(port, 'startRun')
  await post(`/api/rooms/${roomId}/messages`, { text: '@builder name the release' })
  await advance(4000)
  const first = messages().find((message) => message.author.kind === 'agent')!
  expect(first.alternativeOf).toBeUndefined()

  const another = await post(`/api/rooms/${roomId}/messages/${first.id}/retry`, { another: true })
  expect(another.statusCode).toBe(202)
  await advance(4000)
  expect(run.mock.calls.at(-1)![0].input).toContain('The person asked for another answer')
  const second = messages().find((message) => message.id === another.json().messageId)!
  expect(second.alternativeOf).toBe(first.id)

  // Another of another states the request once; a plain Retry repeats a version as it was asked. Both stay in the group.
  const third = await post(`/api/rooms/${roomId}/messages/${second.id}/retry`, { another: true })
  await advance(4000)
  expect(run.mock.calls.at(-1)![0].input.match(/another answer/g)).toHaveLength(1)
  expect(messages().find((message) => message.id === third.json().messageId)!.alternativeOf).toBe(
    first.id,
  )
  const retry = await post(`/api/rooms/${roomId}/messages/${second.id}/retry`, {})
  expect(retry.statusCode).toBe(202)
  await advance(4000)
  expect(messages().find((message) => message.id === retry.json().messageId)!.alternativeOf).toBe(
    first.id,
  )
  expect(
    (await post(`/api/rooms/${roomId}/messages/${first.id}/retry`, { another: 'yes' })).statusCode,
  ).toBe(400)
})
