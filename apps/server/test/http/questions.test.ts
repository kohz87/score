import { AgentQuestionListSchema, RoomSchema, type Message } from '@score/contract'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { buildApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { migrate, openDatabase, type ScoreDb } from '../../src/db/index.ts'
import { HttpError } from '../../src/errors.ts'
import { FakePort } from '../../src/hermes/fake/fake-port.ts'
import { createIngest, type Ingest } from '../../src/hub/ingest.ts'
import { messageFromRow } from '../../src/domain/rooms.ts'
import { FakeScheduler } from '../hermes/fake-scheduler.ts'
import { onMentions } from '../helpers/on-mentions.ts'

// 2.3.0 (decision 128): agent questions end to end on the fake adapter, and the deleted-session recovery.
let dir: string
let db: ScoreDb
let ingest: Ingest
let port: FakePort
let scheduler: FakeScheduler
let app: ReturnType<typeof buildApp>
let headers: { 'x-score-client': string; cookie: string }
let roomId: string

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'score-questions-'))
  db = openDatabase(join(dir, 'score.db'))
  migrate(db, fileURLToPath(new URL('../../migrations/', import.meta.url)))
  scheduler = new FakeScheduler()
  const clock = () => scheduler.now()
  ingest = createIngest(db, { clock })
  port = new FakePort(1, { db, scheduler }, false, () => ({ text: 'Done.', tools: [] }))
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
  const created = await post('/api/rooms', { name: 'questions', leadAgentId: 'lead' })
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
const send = (text: string) => post(`/api/rooms/${roomId}/messages`, { text })
async function advance(ms: number) {
  for (let i = 0; i < 10; i++) {
    await scheduler.advance(ms / 10)
    await ingest.flushListeners()
    await ingest.drain()
  }
}
const pending = async () =>
  AgentQuestionListSchema.parse(
    (await app.inject({ method: 'GET', url: `/api/questions?room=${roomId}`, headers })).json(),
  ).items
const messages = (): Message[] =>
  db.read((sqlite) =>
    sqlite
      .prepare('SELECT * FROM messages WHERE room_id = ? ORDER BY created_at, rowid')
      .all(roomId)
      .map(messageFromRow),
  )
const texts = () =>
  messages().flatMap((message) =>
    message.parts.flatMap((part) => (part.kind === 'text' ? [part.text] : [])),
  )

test('a question with options waits for the person, takes only an offered option, and the reply continues', async () => {
  expect((await send('@builder ask me to pick a branch')).statusCode).toBe(200)
  await advance(2000)
  const [question] = await pending()
  expect(question).toMatchObject({
    agentId: 'builder',
    roomId,
    question: 'Which branch should I use?',
    options: ['main', 'develop'],
    multiSelect: false,
    status: 'pending',
    delivery: 'none',
  })
  const bad = await post(`/api/questions/${question!.id}/answer`, { answer: 'release' })
  expect(bad.statusCode).toBe(400)
  const answered = await post(`/api/questions/${question!.id}/answer`, { answer: 'main' })
  expect(answered.statusCode).toBe(202)
  expect(answered.json()).toMatchObject({ delivery: 'delivering', status: 'pending' })
  const again = await post(`/api/questions/${question!.id}/answer`, { answer: 'develop' })
  expect(again.statusCode).toBe(409)
  await advance(4000)
  expect(await pending()).toEqual([])
  const final = (
    await app.inject({ method: 'GET', url: `/api/questions/${question!.id}`, headers })
  ).json()
  expect(final).toMatchObject({
    status: 'answered',
    answeredBy: 'you',
    delivery: 'applied',
    answer: 'main',
  })
  expect(texts().join(' ')).toContain('going with main')
})

test('a written answer and a multi-select answer reach the agent as Hermes takes them', async () => {
  await send('@builder ask me')
  await advance(2000)
  const [free] = await pending()
  expect(free).toMatchObject({ options: [], multiSelect: false })
  expect((await post(`/api/questions/${free!.id}/answer`, { answer: ['x'] })).statusCode).toBe(400)
  expect(
    (await post(`/api/questions/${free!.id}/answer`, { answer: 'Northwind' })).statusCode,
  ).toBe(202)
  await advance(4000)
  expect(texts().join(' ')).toContain('going with Northwind')

  await send('@reviewer ask me to choose several')
  await advance(2000)
  const [multi] = await pending()
  expect(multi).toMatchObject({ multiSelect: true, options: ['staging', 'production', 'preview'] })
  expect(
    (await post(`/api/questions/${multi!.id}/answer`, { answer: ['staging', 'staging'] }))
      .statusCode,
  ).toBe(400)
  const spy = vi.spyOn(port, 'answerQuestion')
  expect(
    (await post(`/api/questions/${multi!.id}/answer`, { answer: ['staging', 'preview'] }))
      .statusCode,
  ).toBe(202)
  await advance(4000)
  expect(spy.mock.calls[0]![0].answer).toBe('["staging","preview"]')
  expect(texts().join(' ')).toContain('going with staging and preview')
})

test('a delivery that fails leaves the question pending for another answer; one Hermes no longer waits for closes', async () => {
  await send('@builder ask me')
  await advance(2000)
  const [question] = await pending()
  vi.spyOn(port, 'answerQuestion').mockRejectedValueOnce(new Error('gateway down'))
  await post(`/api/questions/${question!.id}/answer`, { answer: 'first' })
  await advance(100)
  expect((await pending())[0]).toMatchObject({
    status: 'pending',
    delivery: 'failed',
    answer: null,
  })
  vi.spyOn(port, 'answerQuestion').mockResolvedValueOnce('not_pending')
  await post(`/api/questions/${question!.id}/answer`, { answer: 'second' })
  await advance(100)
  expect(await pending()).toEqual([])
})

test('stopping the run withdraws its question', async () => {
  await send('@builder ask me')
  await advance(2000)
  const [question] = await pending()
  await port.stopRun({ agentId: 'builder', runId: question!.runId })
  await advance(2000)
  expect(await pending()).toEqual([])
  const final = (
    await app.inject({ method: 'GET', url: `/api/questions/${question!.id}`, headers })
  ).json()
  expect(final).toMatchObject({ status: 'withdrawn' })
})

test('a deleted Hermes session moves the agent to a successor and sends the reply again once', async () => {
  const real = port.startRun.bind(port)
  const start = vi
    .spyOn(port, 'startRun')
    .mockRejectedValueOnce(
      new HttpError(409, 'session_deleted', 'Hermes deleted this conversation.'),
    )
    .mockImplementation(real)
  await send('@builder hello again')
  await advance(4000)
  const sessions = start.mock.calls.map(([req]) => req.sessionId)
  expect(sessions).toHaveLength(2)
  expect(sessions[1]).toBe(`${sessions[0]}~2`)
  expect(texts().join(' ')).toContain('was deleted in Hermes')
  expect(texts().join(' ')).toContain('Done.')
  // Later turns stay in the successor.
  await send('@builder and again')
  await advance(4000)
  expect(start.mock.calls.at(-1)![0].sessionId).toBe(`${sessions[0]}~2`)
})

test('a successor that is refused again gets the notice but no second automatic retry', async () => {
  const start = vi
    .spyOn(port, 'startRun')
    .mockRejectedValue(new HttpError(409, 'session_deleted', 'Hermes deleted this conversation.'))
  await send('@builder hello')
  await advance(6000)
  expect(start.mock.calls.map(([req]) => req.sessionId?.replace(/^.*?(~\d+)?$/, '$1'))).toEqual([
    '',
    '~2',
  ])
  expect(texts().filter((text) => text.includes('was deleted in Hermes'))).toHaveLength(2)
})

test('a deleted session while the team is paused keeps the successor and the notice, without the retry', async () => {
  // The team pauses while Hermes refuses the start: the retry can't be queued.
  const start = vi.spyOn(port, 'startRun').mockImplementationOnce(async () => {
    db.sqlite.prepare("UPDATE team_state SET paused_at = '2026-10-26T00:00:00.000Z'").run()
    throw new HttpError(409, 'session_deleted', 'Hermes deleted this conversation.')
  })
  await send('@builder hello')
  await advance(4000)
  expect(start).toHaveBeenCalledTimes(1)
  expect(texts().join(' ')).toContain('was deleted in Hermes')
  expect(db.sqlite.prepare('SELECT count(*) AS n FROM session_successors').get()).toEqual({ n: 1 })
})
