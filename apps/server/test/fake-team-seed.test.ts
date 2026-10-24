import { JobResultsSchema, type Job, type MessagePart } from '@score/contract'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { buildApp } from '../src/app.ts'
import { loadConfig } from '../src/config.ts'
import { migrate, openDatabase, type ScoreDb } from '../src/db/index.ts'
import { ensureTeamRoom } from '../src/domain/team-room.ts'
import { FakePort } from '../src/hermes/fake/fake-port.ts'
import { seedFakeTeam } from '../src/hermes/fake/team-seed.ts'
import { createIngest, type Ingest } from '../src/hub/ingest.ts'
import { FakeScheduler } from './hermes/fake-scheduler.ts'

// PLAN 11.2c: the fake adapter's seeded team room holds every board state the bold-shell UI tasks build against.

const AGENTS = ['lead', 'builder', 'reviewer', 'designer']
let dir: string
let db: ScoreDb
let ingest: Ingest
let port: FakePort
let scheduler: FakeScheduler
let app: ReturnType<typeof buildApp>
let headers: { 'x-score-client': string; cookie: string }
let nowMs: number
let roomId: string
let feedId: string
let notesId: string
let queueId: string

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'score-team-seed-'))
  db = openDatabase(join(dir, 'score.db'))
  migrate(db, fileURLToPath(new URL('../migrations/', import.meta.url)))
  scheduler = new FakeScheduler()
  const clock = () => scheduler.now()
  ingest = createIngest(db, { clock })
  port = new FakePort(1, { db, scheduler }, false, () => ({ text: 'Working on it.', tools: [] }))
  await port.start(ingest)
  nowMs = Date.now()
  db.tx((sqlite) => ensureTeamRoom(sqlite, AGENTS, new Date(nowMs).toISOString()))
  seedFakeTeam(db.sqlite, nowMs)
  app = buildApp({
    config: loadConfig({ SCORE_MODE: 'fake' }),
    logger: false,
    db,
    ingest,
    port,
    clock: () => nowMs,
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
  roomId = ((await get('/api/team-room')).json() as { room: { id: string } }).room.id
  const jobs = (await get('/api/team-room')).json().jobs as Job[]
  feedId = jobs.find((job) => job.title === 'Activity feed')!.id
  notesId = jobs.find((job) => job.title === 'Release notes 2.4')!.id
  queueId = jobs.find((job) => job.title === 'Queue research')!.id
})

afterEach(async () => {
  await port.stop()
  await app.close()
  await ingest.close()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const get = (url: string) => app.inject({ url, headers })

test('the team room lists the four demo jobs with their board states', async () => {
  const team = (await get('/api/team-room')).json() as {
    room: { leadAgentId: string }
    jobs: Job[]
  }
  expect(team.room.leadAgentId).toBe('lead')
  expect(team.jobs).toHaveLength(4)
  const byTitle = new Map(team.jobs.map((job) => [job.title, job]))
  expect(byTitle.get('Activity feed')).toMatchObject({
    state: 'working',
    holderAgentId: 'builder',
    unread: 0,
  })
  const notes = byTitle.get('Release notes 2.4')!
  expect(notes.state).toBe('waiting_on_you')
  expect(notes.unread).toBeGreaterThan(0)
  expect(byTitle.get('Queue research')?.state).toBe('done')
  expect(byTitle.get('Team room')?.isDefault).toBe(true)
})

test('the Activity feed review completed over two rounds and its results are complete', async () => {
  const exchanges = (await get(`/api/jobs/${feedId}/exchanges`)).json().items
  expect(exchanges).toMatchObject([
    {
      kind: 'review',
      from: 'builder',
      to: 'reviewer',
      state: 'done',
      outcome: 'approved',
      round: 2,
      turnsUsed: 4,
      budget: 8,
      pause: null,
      queuedBehind: null,
    },
  ])

  const results = JobResultsSchema.parse((await get(`/api/jobs/${feedId}/results`)).json())
  const change = results.items.find((item) => item.kind === 'change')
  expect(change).toMatchObject({
    kind: 'change',
    title: 'Activity feed',
    authors: ['builder'],
    state: 'approved',
    whatChanged: expect.arrayContaining([
      {
        text: 'Events in the same millisecond get skipped.',
        by: 'reviewer',
        caught: true,
      },
      { text: 'Approved by reviewer', by: 'reviewer', caught: false },
    ]),
  })
  expect(change?.kind === 'change' && change.files).toEqual([
    { path: 'api/events.py', added: 15, removed: 3, by: ['builder'] },
    { path: 'api/test_events.py', added: 20, removed: 0, by: ['builder'] },
  ])
  expect(results.items.find((item) => item.kind === 'preview')).toMatchObject({
    kind: 'preview',
    agentId: 'builder',
    title: 'Activity feed',
    live: true,
  })
  expect(results.screens).toEqual([
    expect.objectContaining({
      agentId: 'builder',
      surface: 'terminal',
      caption: 'Ran pnpm test api/events',
      live: true,
    }),
  ])
})

test('the Release notes review is paused at 8 of 8 turns and offers the budget choices', async () => {
  const exchanges = (await get(`/api/jobs/${notesId}/exchanges`)).json().items
  expect(exchanges).toMatchObject([
    {
      kind: 'review',
      from: 'lead',
      to: 'reviewer',
      state: 'paused_budget',
      outcome: null,
      round: 5,
      turnsUsed: 8,
      budget: 8,
      pause: {
        reason: 'exchange_budget',
        options: ['more_turns', 'step_in', 'stop'],
      },
    },
  ])
  const held = db.sqlite.prepare('SELECT held FROM exchanges WHERE job_id = ?').get(notesId) as {
    held: string | null
  }
  expect(JSON.parse(held.held!)).toMatchObject({
    agentId: 'reviewer',
    exchangeId: expect.any(String),
  })

  const results = JobResultsSchema.parse((await get(`/api/jobs/${notesId}/results`)).json())
  expect(results.items.find((item) => item.kind === 'draft')).toMatchObject({
    kind: 'draft',
    agentId: 'designer',
    title: 'Announcement image.md',
    target: { kind: 'document', mediaId: 'seed_notes_announcement' },
  })
})

test('a pending package approval is a needs-you card for builder', async () => {
  const approvals = (await get('/api/approvals?status=pending')).json().items
  expect(approvals).toEqual([
    expect.objectContaining({
      agentId: 'builder',
      title: 'May I install a package?',
      command: 'npm install ws@8',
      status: 'pending',
      actionable: true,
    }),
  ])
  const card = db.sqlite
    .prepare("SELECT job_id, parts FROM messages WHERE id LIKE 'approval:%'")
    .get() as { job_id: string; parts: string }
  expect(card.job_id).toBe(feedId)
  expect(JSON.parse(card.parts)).toEqual([{ kind: 'approval', approvalId: expect.any(String) }])
})

test('builder’s direct room has the three prototype chats; reviewer has one', async () => {
  const builder = (await get('/api/agents/builder/direct')).json()
  expect(builder.chats).toHaveLength(3)
  expect(builder.chats.map((chat: Job) => chat.title)).toEqual([
    'Websockets or server-sent events',
    'The cursor bug',
    'Working in the Docker sandbox',
  ])
  expect(builder.chats.map((chat: Job) => chat.summary)).toEqual([
    'Why websockets and not server-sent events?',
    'Why did reviewer send the read layer back?',
    'Can you work inside the Docker sandbox from now on?',
  ])
  const reviewer = (await get('/api/agents/reviewer/direct')).json()
  expect(reviewer.chats).toHaveLength(1)
  expect(reviewer.chats[0]).toMatchObject({
    title: 'How strict to be on docs',
    summary: 'How strict should you be on docs?',
  })
})

test('the Activity feed job carries a frozen reference and one shared one-to-one message', async () => {
  const parts = db.sqlite
    .prepare('SELECT parts FROM messages WHERE job_id = ? ORDER BY created_at, id')
    .all(feedId)
    .flatMap((row) => JSON.parse((row as { parts: string }).parts) as MessagePart[])
  const ref = parts.find((part) => part.kind === 'ref')
  expect(ref).toMatchObject({
    kind: 'ref',
    target: { kind: 'job', jobId: expect.any(String) },
    title: 'Websockets or server-sent events',
    summary: expect.stringContaining('Why websockets and not server-sent events?'),
  })
  expect(parts.find((part) => part.kind === 'shared')).toMatchObject({
    kind: 'shared',
    text: 'Using created_at alone, two events written in the same millisecond collide and one is skipped. I switched the cursor to (created_at, id) and added a test.',
  })
})

test('the team room has one pinned decision', async () => {
  expect((await get(`/api/rooms/${roomId}/pins`)).json()).toEqual({
    items: [
      {
        messageId: 'seed_pinned_decision',
        text: 'Event cursors are (created_at, id)',
        pinnedAt: expect.any(String),
      },
    ],
  })
})

test('seeding twice changes nothing', () => {
  const tables = [
    'rooms',
    'jobs',
    'job_sessions',
    'job_reads',
    'messages',
    'message_runs',
    'runs',
    'exchanges',
    'exchange_actions',
    'watch_frames',
    'approvals',
    'room_pins',
  ]
  const counts = () =>
    Object.fromEntries(
      tables.map((table) => [
        table,
        (db.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n,
      ]),
    )
  const before = counts()
  seedFakeTeam(db.sqlite, nowMs)
  expect(counts()).toEqual(before)
})
