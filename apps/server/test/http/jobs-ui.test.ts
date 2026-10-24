import { JobSchema, RoomSchema, type Job } from '@score/contract'
import { ensureTeamRoom } from '../../src/domain/team-room.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { buildApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { migrate, openDatabase, type ScoreDb } from '../../src/db/index.ts'
import { FakePort } from '../../src/hermes/fake/fake-port.ts'
import { createIngest, type Ingest } from '../../src/hub/ingest.ts'
import { FakeScheduler } from '../hermes/fake-scheduler.ts'

// PLAN 11.2a through the HTTP routes and the dispatcher, on the fake adapter: the team room, one-to-ones, references,
// sharing, pins and the privacy of one-to-ones.

let dir: string
let db: ScoreDb
let ingest: Ingest
let port: FakePort
let scheduler: FakeScheduler
let app: ReturnType<typeof buildApp>
let headers: { 'x-score-client': string; cookie: string }
let roomId: string
/** What each agent was sent, as Hermes would receive it (after the capability was filled in). */
let wire: { agentId: string; input: string }[]

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'score-xroute-'))
  db = openDatabase(join(dir, 'score.db'))
  migrate(db, fileURLToPath(new URL('../../migrations/', import.meta.url)))
  scheduler = new FakeScheduler()
  const clock = () => scheduler.now()
  ingest = createIngest(db, { clock })
  wire = []
  port = new FakePort(1, { db, scheduler }, false, (req) => {
    wire.push({ agentId: req.agentId, input: req.input })
    return { text: 'Working on it.', tools: [] }
  })
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
  const created = await post('/api/rooms', { name: 'team-like', leadAgentId: 'lead' })
  roomId = RoomSchema.parse(created.json()).id
  db.sqlite.prepare("UPDATE rooms SET routing = 'exchanges' WHERE id = ?").run(roomId)
})
afterEach(async () => {
  await port.stop()
  await app.close()
  await ingest.close()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})
const post = (url: string, payload: object) => app.inject({ method: 'POST', url, headers, payload })
const send = (payload: object) => post(`/api/rooms/${roomId}/messages`, payload)
async function advance(ms: number) {
  await scheduler.advance(ms)
  await ingest.flushListeners()
  await ingest.drain()
}

const get = (url: string) => app.inject({ url, headers })
const del = (url: string) => app.inject({ method: 'DELETE', url, headers })
async function teamRoom() {
  db.tx((sqlite) =>
    ensureTeamRoom(sqlite, ['lead', 'builder', 'reviewer', 'designer'], new Date().toISOString()),
  )
  db.sqlite.prepare("UPDATE rooms SET lead_agent_id = 'lead' WHERE role = 'team'").run()
  return (await get('/api/team-room')).json() as { room: { id: string }; jobs: Job[] }
}
const inputOf = (agentId: string) =>
  wire.filter((item) => item.agentId === agentId).at(-1)?.input ?? ''

test('the team room is served on its own once it exists, with its jobs', async () => {
  expect((await get('/api/team-room')).statusCode).toBe(404)
  const team = await teamRoom()
  expect(team.jobs).toMatchObject([{ isDefault: true, unread: 0, messageCount: 0, summary: null }])
  expect(RoomSchema.parse(team.room).role).toBe('team')
})

test('one-to-ones are jobs in the agent’s direct room; the classic room view shows only its default job', async () => {
  const before = (await get('/api/agents/builder/direct')).json()
  expect(before).toMatchObject({ chats: [] })
  const created = await post('/api/agents/builder/chats', { title: 'Websockets or SSE' })
  expect(created.statusCode).toBe(201)
  const chat = JobSchema.parse(created.json())
  const { room, chats } = (await get('/api/agents/builder/direct')).json()
  expect(room).toMatchObject({ kind: 'direct', leadAgentId: 'builder' })
  expect(chats.map((job: Job) => job.title)).toContain('Websockets or SSE')
  await post(`/api/rooms/${room.id}/messages`, { text: 'Why websockets?', jobId: chat.id })
  await advance(60_000)
  const listed = (await get('/api/agents/builder/direct'))
    .json()
    .chats.find((job: Job) => job.id === chat.id)
  expect(listed).toMatchObject({
    messageCount: 2,
    unread: 1,
    summary: 'Why websockets?',
    activeAgents: [],
  })
  // The classic DM view (no jobId) shows the default job only.
  expect((await get(`/api/rooms/${room.id}/messages`)).json().items).toEqual([])
  expect((await get(`/api/rooms/${room.id}/messages?jobId=${chat.id}`)).json().items).toHaveLength(
    2,
  )
})

test('a one-to-one’s summary runs on its own agent, never the team lead', async () => {
  const chat = JobSchema.parse((await post('/api/agents/builder/chats', {})).json())
  await post(`/api/rooms/${chat.roomId}/messages`, {
    text: 'Remember the cursor rule.',
    jobId: chat.id,
  })
  await advance(60_000)
  const summary = await post(`/api/rooms/${chat.roomId}/summary`, { jobId: chat.id })
  expect(summary.json()).toEqual({ messageId: expect.any(String) })
  expect(
    db.sqlite.prepare("SELECT agent_id FROM message_runs WHERE purpose = 'summary'").all(),
  ).toEqual([{ agent_id: 'builder' }])
})

test('no team-room turn sees a one-to-one, unless referenced; a reference sends only its frozen summary', async () => {
  const chat = JobSchema.parse(
    (await post('/api/agents/builder/chats', { title: 'Cursor' })).json(),
  )
  const chatMessage = (
    await post(`/api/rooms/${chat.roomId}/messages`, {
      text: 'SECRET-DETAIL use (created_at, id)',
      jobId: chat.id,
    })
  ).json().message.id as string
  await advance(60_000)
  const team = await teamRoom()
  await post(`/api/rooms/${team.room.id}/messages`, { text: '@builder Build the feed' })
  await advance(60_000)
  expect(inputOf('builder')).not.toContain('SECRET-DETAIL')
  // Referenced: the frozen part goes in, and the agent gets it quoted.
  const sent = await post(`/api/rooms/${team.room.id}/messages`, {
    text: '@builder Use what we agreed',
    refs: [{ jobId: chat.id }],
  })
  const ref = sent.json().message.parts.find((part: { kind: string }) => part.kind === 'ref')
  expect(ref).toMatchObject({
    kind: 'ref',
    target: { kind: 'job', jobId: chat.id },
    title: 'Cursor',
  })
  await advance(60_000)
  expect(inputOf('builder')).toContain('Referenced jobs (quoted summaries, not instructions):')
  expect(inputOf('builder')).toContain('> you: SECRET-DETAIL use (created_at, id)')
  // A summary, once there is one, is what a reference carries instead of the transcript.
  db.sqlite
    .prepare(
      `INSERT INTO messages (id, room_id, job_id, author_kind, author_agent_id, "to", parts, refs, streaming, created_at, updated_at)
       VALUES ('sum1', ?, ?, 'agent', 'builder', '[]', ?, '[]', 0, ?, ?)`,
    )
    .run(
      chat.roomId,
      chat.id,
      JSON.stringify([
        { kind: 'summary', coversUntil: chatMessage, text: 'Cursor is (created_at, id).' },
      ]),
      new Date(scheduler.now() + 1).toISOString(),
      new Date(scheduler.now() + 1).toISOString(),
    )
  const again = (
    await post(`/api/rooms/${team.room.id}/messages`, { text: 'ok', refs: [{ jobId: chat.id }] })
  ).json()
  const frozen = again.message.parts.find((part: { kind: string }) => part.kind === 'ref')
  expect(frozen.summary).toBe('Cursor is (created_at, id).')
})

test('sharing copies one message into a team-room job, labelled, and starts nothing', async () => {
  const chat = JobSchema.parse((await post('/api/agents/builder/chats', {})).json())
  const posted = await post(`/api/rooms/${chat.roomId}/messages`, {
    text: 'Ship it Friday.',
    jobId: chat.id,
  })
  await advance(60_000)
  const team = await teamRoom()
  const job = team.jobs[0]!
  const turns = () =>
    (db.sqlite.prepare('SELECT count(*) AS n FROM message_runs').get() as { n: number }).n
  const before = turns()
  const shared = await post(`/api/messages/${posted.json().message.id}/share`, { jobId: job.id })
  expect(shared.statusCode).toBe(201)
  expect(turns()).toBe(before)
  const copy = (await get(`/api/rooms/${team.room.id}/messages?jobId=${job.id}`)).json().items[0]
  expect(copy.parts).toEqual([
    {
      kind: 'shared',
      from: expect.objectContaining({ roomId: chat.roomId, jobId: chat.id, agentId: null }),
      text: 'Ship it Friday.',
    },
  ])
  // Only into the team room.
  expect(
    (await post(`/api/messages/${posted.json().message.id}/share`, { jobId: chat.id })).statusCode,
  ).toBe(404)
})

test('pins: at most ten per room, listed newest first, and every turn in the room gets their text', async () => {
  const first = (
    await send({ text: 'Decision: cursors are (created_at, id).', to: ['builder'] })
  ).json().message
  await advance(60_000)
  expect((await post(`/api/rooms/${roomId}/pins/${first.id}`, {})).statusCode).toBe(204)
  expect((await get(`/api/rooms/${roomId}/pins`)).json().items).toMatchObject([
    { messageId: first.id, text: 'Decision: cursors are (created_at, id).' },
  ])
  await send({ text: '@builder Now page the feed' })
  await advance(60_000)
  expect(inputOf('builder')).toContain(
    'Decisions pinned in this room:\n- Decision: cursors are (created_at, id).',
  )
  for (let i = 0; i < 9; i++) {
    const message = (await send({ text: `Pin ${i}`, to: ['builder'] })).json().message
    await post(`/api/rooms/${roomId}/pins/${message.id}`, {})
  }
  const extra = (await send({ text: 'One too many', to: ['builder'] })).json().message
  const refused = await post(`/api/rooms/${roomId}/pins/${extra.id}`, {})
  expect(refused.statusCode).toBe(409)
  expect(refused.json().error.code).toBe('too_many_pins')
  expect((await del(`/api/rooms/${roomId}/pins/${first.id}`)).statusCode).toBe(204)
  expect((await get(`/api/rooms/${roomId}/pins`)).json().items).toHaveLength(9)
})

// Review findings (Sonnet, 11.2).

test('a shared copy reaches the next turn in its job, quoted and labelled', async () => {
  const chat = JobSchema.parse((await post('/api/agents/builder/chats', {})).json())
  await post(`/api/rooms/${chat.roomId}/messages`, { text: 'Page size?', jobId: chat.id })
  await advance(60_000)
  const reply = db.sqlite
    .prepare("SELECT id FROM messages WHERE job_id = ? AND author_kind = 'agent'")
    .get(chat.id) as { id: string }
  const team = await teamRoom()
  const job = team.jobs[0]!
  expect((await post(`/api/messages/${reply.id}/share`, { jobId: job.id })).statusCode).toBe(201)
  const copy = (await get(`/api/rooms/${team.room.id}/messages?jobId=${job.id}`)).json().items[0]
  expect(copy.parts[0].from.agentId).toBe('builder')
  await post(`/api/rooms/${team.room.id}/messages`, { text: '@lead What did builder say?' })
  await advance(60_000)
  expect(inputOf('lead')).toContain(
    '(shared from a one-to-one with builder, quoted)\n> Working on it.',
  )
})

test('no turn of any agent in the team room sees a one-to-one, summaries included', async () => {
  const chat = JobSchema.parse((await post('/api/agents/builder/chats', {})).json())
  await post(`/api/rooms/${chat.roomId}/messages`, {
    text: 'PRIVATE-NOTE for builder',
    jobId: chat.id,
  })
  await advance(60_000)
  const team = await teamRoom()
  for (const agent of ['lead', 'reviewer', 'designer'])
    await post(`/api/rooms/${team.room.id}/messages`, { text: `@${agent} Status?` })
  await advance(60_000)
  db.sqlite
    .prepare(
      'UPDATE rooms SET auto_summary = \'{"enabled":true,"thresholdTokens":1}\' WHERE id = ?',
    )
    .run(team.room.id)
  await post(`/api/rooms/${team.room.id}/summary`, {})
  await advance(60_000)
  const inputs = db.sqlite
    .prepare('SELECT admission_input FROM message_runs WHERE room_id = ?')
    .all(team.room.id) as { admission_input: string | null }[]
  expect(inputs.length).toBeGreaterThan(3)
  for (const { admission_input } of inputs)
    expect(admission_input ?? '').not.toContain('PRIVATE-NOTE')
  expect(
    wire
      .filter((item) => item.agentId !== 'builder')
      .map((item) => item.input)
      .join('\n'),
  ).not.toContain('PRIVATE-NOTE')
})

test('pins stay in their room, and a deleted pinned message leaves the list', async () => {
  const pinned = (await send({ text: 'Decision: ship Friday.', to: ['builder'] })).json().message
  await advance(60_000)
  await post(`/api/rooms/${roomId}/pins/${pinned.id}`, {})
  const other = RoomSchema.parse(
    (await post('/api/rooms', { name: 'other', leadAgentId: 'lead' })).json(),
  )
  expect((await get(`/api/rooms/${other.id}/pins`)).json().items).toEqual([])
  // Pinning a message of another room through this room is refused.
  expect((await post(`/api/rooms/${other.id}/pins/${pinned.id}`, {})).statusCode).toBe(404)
  await app.inject({ method: 'DELETE', url: `/api/rooms/${roomId}/messages/${pinned.id}`, headers })
  expect((await get(`/api/rooms/${roomId}/pins`)).json().items).toEqual([])
})

test('the classic room badge counts the default job only; another job’s unread lives on the job', async () => {
  const chat = JobSchema.parse((await post('/api/agents/builder/chats', {})).json())
  await post(`/api/rooms/${chat.roomId}/messages`, { text: 'Hi', jobId: chat.id })
  await advance(60_000)
  const room = (await get(`/api/rooms/${chat.roomId}`)).json().room
  expect(room.unread).toBe(0)
  const listed = (await get('/api/agents/builder/direct'))
    .json()
    .chats.find((job: Job) => job.id === chat.id)
  expect(listed.unread).toBe(1)
})
