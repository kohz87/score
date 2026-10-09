import { RoomSchema } from '@score/contract'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { buildApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { importOutsideSession } from '../../src/domain/outside-sessions.ts'
import { migrate, openDatabase, type ScoreDb } from '../../src/db/index.ts'
import { createHermesPort, type HermesPort } from '../../src/hermes/index.ts'
import { createIngest, type Ingest } from '../../src/hub/ingest.ts'
import { FakeScheduler } from '../hermes/fake-scheduler.ts'

let dir: string
let db: ScoreDb
let ingest: Ingest
let port: HermesPort
let scheduler: FakeScheduler
let app: ReturnType<typeof buildApp>
let headers: { 'x-score-client': string; cookie: string }

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'score-outside-'))
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
  vi.spyOn(port, 'startRun').mockResolvedValue({ runId: 'outside-run' })
})
afterEach(async () => {
  vi.restoreAllMocks()
  await port.stop()
  await app.close()
  await ingest.close()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const post = (url: string, payload: object = {}, withHeaders = headers) =>
  app.inject({ method: 'POST', url, headers: withHeaders, payload })
const importSession = (agentId: string, sessionId: string) =>
  post('/api/outside-sessions/import', { agentId, sessionId })

test('lists each agent’s outside sessions with source, title, time, count and busy', async () => {
  const response = await app.inject({ url: '/api/outside-sessions' })
  expect(response.statusCode).toBe(200)
  const { items, unavailable } = response.json()
  expect(unavailable).toEqual([])
  expect(items.map((item: { id: string }) => item.id)).toEqual([
    'ext-discord-1',
    'ext-cli-1',
    'ext-telegram-1',
  ])
  expect(items.find((item: { id: string }) => item.id === 'ext-telegram-1')).toMatchObject({
    agentId: 'lead',
    source: 'telegram',
    sourceLabel: 'Telegram',
    title: 'Plan the launch checklist',
    messageCount: 4,
    busy: false,
    roomId: null,
  })
  expect(items.find((item: { id: string }) => item.id === 'ext-discord-1').busy).toBe(true)
  // A session without a title shows its first user message.
  expect(items.find((item: { id: string }) => item.id === 'ext-cli-1').title).toBe(
    'Why is the parser test flaky on CI?',
  )
})

test('import makes a room of redacted, read-only copies marked as imported; nothing is unread', async () => {
  expect((await importSession('lead', 'ext-telegram-1')).statusCode).toBe(200)
  const imported = (await importSession('lead', 'ext-telegram-1')).json()
  expect(imported).toEqual({ roomId: expect.any(String), imported: 0 })
  const rooms = (await app.inject({ url: '/api/rooms' })).json().rooms
  const room = RoomSchema.parse(rooms.find((item: { id: string }) => item.id === imported.roomId))
  expect(room).toMatchObject({
    kind: 'room',
    leadAgentId: 'lead',
    members: ['lead'],
    unread: 0,
    importedFrom: {
      agentId: 'lead',
      sessionId: 'ext-telegram-1',
      source: 'telegram',
      label: 'Telegram',
      continued: null,
    },
  })
  expect(room.name).toBe('#telegram-plan-the-launch-checklist #imported #telegram')
  expect(room.tags).toEqual(['imported', 'telegram'])
  const page = (await app.inject({ url: `/api/rooms/${room.id}/messages` })).json().items
  expect(page).toHaveLength(4)
  const oldest = [...page].reverse()
  expect(oldest[0]).toMatchObject({
    id: `import:${room.id}:0`,
    author: { kind: 'you' },
    parts: [{ kind: 'text', text: 'Can you outline the launch checklist for next week?' }],
    streaming: false,
  })
  expect(oldest[1].author).toEqual({ kind: 'agent', agentId: 'lead' })
  expect(JSON.stringify(page)).not.toContain('sk-fakefakefakefake123')
  expect(oldest[2].parts[0].text).toContain('api_key=[redacted]')
  // Original times are kept.
  expect(Date.parse(oldest[0].createdAt)).toBeLessThan(scheduler.now() - 29 * 3_600_000)
  // Listed sessions now point to their room.
  const listed = (await app.inject({ url: '/api/outside-sessions' })).json().items
  expect(listed.find((item: { id: string }) => item.id === 'ext-telegram-1').roomId).toBe(room.id)
  // Imported messages are searchable too.
  const hits = (await app.inject({ url: '/api/search/messages?q=checklist' })).json().items
  expect(hits.length).toBeGreaterThan(0)
})

test('import needs a paired browser, a known agent and an existing session', async () => {
  const unpaired = { 'x-score-client': 'web', cookie: '' }
  expect(
    (
      await post(
        '/api/outside-sessions/import',
        { agentId: 'lead', sessionId: 'ext-telegram-1' },
        unpaired,
      )
    ).statusCode,
  ).toBe(401)
  expect((await importSession('nobody', 'ext-telegram-1')).statusCode).toBe(404)
  expect((await importSession('lead', 'missing')).statusCode).toBe(404)
  // A session of another agent is not readable through this one.
  expect((await importSession('builder', 'ext-telegram-1')).statusCode).toBe(404)
  expect((await post('/api/outside-sessions/import', { agentId: 'lead' })).statusCode).toBe(400)
})

async function importedRoom(agentId: string, sessionId: string) {
  const imported = (await importSession(agentId, sessionId)).json()
  return imported.roomId as string
}
const say = (roomId: string, text: string, to: string[]) =>
  post(`/api/rooms/${roomId}/messages`, { text, to })

test('continue here: new turns go into the same Hermes session when the gateway accepts it', async () => {
  const roomId = await importedRoom('lead', 'ext-telegram-1')
  const response = await post(`/api/rooms/${roomId}/continue-session`)
  expect(response.statusCode).toBe(200)
  expect(response.json()).toEqual({ mode: 'same_session' })
  const room = (await app.inject({ url: `/api/rooms/${roomId}` })).json().room
  expect(room.importedFrom.continued).toBe('same_session')
  expect((await say(roomId, 'Anything left on the list?', ['lead'])).statusCode).toBe(200)
  await vi.waitFor(() => expect(port.startRun).toHaveBeenCalled())
  expect(vi.mocked(port.startRun).mock.calls[0]![0]).toMatchObject({
    agentId: 'lead',
    sessionId: 'ext-telegram-1',
  })
})

test('without continue, and for other rooms, turns use the room’s own session', async () => {
  const roomId = await importedRoom('lead', 'ext-telegram-1')
  await say(roomId, 'Hello again', ['lead'])
  await vi.waitFor(() => expect(port.startRun).toHaveBeenCalled())
  expect(vi.mocked(port.startRun).mock.calls[0]![0].sessionId).toBe(`score-${roomId}-lead`)
})

test('continue here starts a new session with a one-time summary when the session cannot be reused', async () => {
  vi.spyOn(port, 'sessionContinuation').mockReturnValue('new_session')
  const roomId = await importedRoom('lead', 'ext-telegram-1')
  expect((await post(`/api/rooms/${roomId}/continue-session`)).json()).toEqual({
    mode: 'new_session',
  })
  const stored = db.sqlite.prepare('SELECT * FROM room_sessions WHERE room_id = ?').get(roomId)!
  expect(stored.summary).toContain('imported from Telegram')
  expect(stored.summary).toContain('Review the docs')
  expect(stored.summary).not.toContain('sk-fakefakefakefake123')
  await say(roomId, 'First question here', ['lead'])
  await vi.waitFor(() => expect(port.startRun).toHaveBeenCalledTimes(1))
  const first = vi.mocked(port.startRun).mock.calls[0]![0]
  expect(first.sessionId).toBe(`score-${roomId}-lead`)
  expect(first.input).toContain('Earlier conversation (imported from Telegram')
  // The summary is sent once: the next turn starts without it.
  db.sqlite.prepare("UPDATE message_runs SET state = 'completed' WHERE room_id = ?").run(roomId)
  await say(roomId, 'Second question here', ['lead'])
  await vi.waitFor(() => expect(port.startRun).toHaveBeenCalledTimes(2))
  expect(vi.mocked(port.startRun).mock.calls[1]![0].input).not.toContain('Earlier conversation')
})

test('continue here is refused while the session is still active on its platform', async () => {
  const roomId = await importedRoom('builder', 'ext-discord-1')
  const response = await post(`/api/rooms/${roomId}/continue-session`)
  expect(response.statusCode).toBe(409)
  expect(response.json().error).toMatchObject({ code: 'session_busy' })
  expect(response.json().error.message).toContain('Discord')
  expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM room_sessions').get()?.n).toBe(0)
})

test('continue here only works on imported rooms, for paired browsers', async () => {
  const room = RoomSchema.parse(
    (await post('/api/rooms', { name: 'plain', leadAgentId: 'lead', members: ['lead'] })).json(),
  )
  expect((await post(`/api/rooms/${room.id}/continue-session`)).statusCode).toBe(409)
  expect((await post('/api/rooms/nope/continue-session')).statusCode).toBe(404)
  const imported = await importedRoom('lead', 'ext-telegram-1')
  expect(
    (
      await post(
        `/api/rooms/${imported}/continue-session`,
        {},
        { 'x-score-client': 'web', cookie: '' },
      )
    ).statusCode,
  ).toBe(401)
})

// audit4-c 3: the busy check is repeated before each turn of a continued session.
test('a continued session that becomes busy holds the turn, then fails it with session_busy', async () => {
  const roomId = await importedRoom('lead', 'ext-telegram-1')
  expect((await post(`/api/rooms/${roomId}/continue-session`)).statusCode).toBe(200)
  const real = port.readOutsideSession.bind(port)
  vi.spyOn(port, 'readOutsideSession').mockImplementation(async (agentId, sessionId) => {
    const history = await real(agentId, sessionId)
    return history && { ...history, session: { ...history.session, busy: true } }
  })
  let clock = Date.now()
  vi.spyOn(Date, 'now').mockImplementation(() => clock)
  await say(roomId, 'Anything left?', ['lead'])
  await vi.waitFor(() => expect(port.readOutsideSession).toHaveBeenCalled())
  expect(port.startRun).not.toHaveBeenCalled()
  const state = () =>
    db.sqlite
      .prepare('SELECT state FROM message_runs WHERE room_id = ? ORDER BY created_at, rowid')
      .get(roomId)?.state
  expect(state()).toBe('pending')
  clock += 11 * 60_000
  await say(roomId, 'Still there?', ['lead'])
  expect(port.startRun).not.toHaveBeenCalled()
  expect(state()).toBe('failed')
  const texts = db.sqlite
    .prepare('SELECT parts FROM messages WHERE room_id = ? AND author_kind = ?')
    .all(roomId, 'agent')
    .map((row) => String(row.parts))
  expect(texts.some((text) => text.includes('session_busy'))).toBe(true)
})

// audit4-c 7: a session title can carry a secret; the room name is shown everywhere.
test('the imported room name is made from the redacted session title', async () => {
  const history = (await port.readOutsideSession('lead', 'ext-telegram-1'))!
  const secret = 'sk-fakefakefakefake123456789'
  history.session.title = `deploy with ${secret}`
  let name = ''
  await ingest.submit({
    source: 'test',
    identity: 'import-secret-title',
    apply: ({ sqlite, now }) => {
      const made = importOutsideSession(sqlite, history, now)
      name = String(sqlite.prepare('SELECT name FROM rooms WHERE id = ?').get(made.roomId)?.name)
      return made.events
    },
  })
  expect(name).not.toContain('fakefake')
  expect(name).toContain('deploy-with')
})
