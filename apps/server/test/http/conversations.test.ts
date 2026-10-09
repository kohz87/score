import { RoomSchema, StreamEventSchema, type Message } from '@score/contract'
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { buildApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { migrate, openDatabase, type ScoreDb } from '../../src/db/index.ts'
import { deleteMessage, storeMessage, updateMessage } from '../../src/domain/rooms.ts'
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
let counter = 0

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'score-conv-'))
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
  vi.spyOn(port, 'startRun').mockResolvedValue({ runId: 'conv-run' })
})
afterEach(async () => {
  vi.restoreAllMocks()
  await port.stop()
  await app.close()
  await ingest.close()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const send = (method: 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
  app.inject({ method, url, headers, ...(payload ? { payload } : {}) })
const get = (url: string, withHeaders = false) =>
  app.inject({ method: 'GET', url, ...(withHeaders ? { headers } : {}) })
async function room(name: string) {
  const response = await send('POST', '/api/rooms', {
    name,
    leadAgentId: 'lead',
    members: ['lead', 'builder'],
  })
  expect(response.statusCode).toBe(200)
  return RoomSchema.parse(response.json())
}
async function say(
  roomId: string,
  parts: Message['parts'],
  author: Message['author'] = { kind: 'agent', agentId: 'builder' },
) {
  const message: Message = {
    id: `m-${++counter}`,
    roomId,
    author,
    to: [],
    parts,
    refs: [],
    createdAt: new Date(scheduler.now() + counter * 1000).toISOString(),
    streaming: false,
  }
  await ingest.submit({
    source: 'test',
    identity: `say-${counter}`,
    apply: ({ sqlite, now }) => storeMessage(sqlite, message, now),
  })
  return message
}
const events = () =>
  db.sqlite
    .prepare('SELECT seq, ts, type, data FROM events ORDER BY seq')
    .all()
    .map((row) =>
      StreamEventSchema.parse({ ...row, data: JSON.parse(String(row.data)) as unknown }),
    )

test('pin, archive, project and tags are stored, emitted and validated', async () => {
  const a = await room('alpha')
  expect(a).toMatchObject({ pinned: false, archived: false, projectId: null, tags: [] })
  const project = (
    await send('POST', '/api/room-projects', { name: 'Launch', color: '#4A2FD9' })
  ).json()
  expect(project).toEqual({ id: expect.any(String), name: 'Launch', color: '#4A2FD9' })
  expect(
    (await send('POST', '/api/room-projects', { name: 'launch', color: '#112233' })).statusCode,
  ).toBe(409)
  const patched = await send('PATCH', `/api/rooms/${a.id}`, {
    pinned: true,
    archived: true,
    projectId: project.id,
    tags: ['q4', 'q4', 'urgent'],
  })
  expect(RoomSchema.parse(patched.json())).toMatchObject({
    pinned: true,
    archived: true,
    projectId: project.id,
    tags: ['q4', 'urgent'],
  })
  const upserts = events().filter(
    (event) => event.type === 'room.upserted' && event.data.id === a.id,
  )
  expect(upserts.at(-1)?.data).toMatchObject({
    pinned: true,
    archived: true,
    projectId: project.id,
  })
  const listed = (await get('/api/rooms')).json()
  expect(listed.projects).toEqual([project])
  expect((await send('PATCH', `/api/rooms/${a.id}`, { projectId: 'nope' })).statusCode).toBe(404)
  expect((await send('PATCH', `/api/rooms/${a.id}`, { tags: ['Bad Tag'] })).statusCode).toBe(400)
  // Rename the project, then delete it: the room leaves it and everyone is told.
  await send('PATCH', `/api/room-projects/${project.id}`, { name: 'Ship' })
  expect(
    events().some((event) => event.type === 'room-project.upserted' && event.data.name === 'Ship'),
  ).toBe(true)
  expect((await send('DELETE', `/api/room-projects/${project.id}`)).statusCode).toBe(204)
  const after = (await get(`/api/rooms/${a.id}`)).json().room
  expect(after.projectId).toBeNull()
  expect(events().some((event) => event.type === 'room-project.deleted')).toBe(true)
  // Unpin / explicit tags back to name tags.
  const reset = await send('PATCH', `/api/rooms/${a.id}`, { pinned: false, tags: null })
  expect(RoomSchema.parse(reset.json())).toMatchObject({ pinned: false, tags: [] })
})

test('tags are parsed from the room name unless set explicitly', async () => {
  const tagged = await room('launch #q4 #urgent')
  expect(tagged.name).toBe('#launch #q4 #urgent')
  expect(tagged.tags).toEqual(['q4', 'urgent'])
  expect((await send('POST', '/api/rooms', { name: 'x #Bad_One' })).statusCode).toBe(400)
})

test('organising calls need a paired browser', async () => {
  const unpaired = { 'x-score-client': 'web' }
  for (const [method, url] of [
    ['POST', '/api/room-projects'],
    ['PATCH', '/api/room-projects/x'],
    ['DELETE', '/api/room-projects/x'],
  ] as const) {
    const response = await app.inject({ method, url, headers: unpaired, payload: {} })
    expect(response.statusCode).toBe(401)
  }
})

test('message search: tokenised, per room, excludes deleted and streaming, redacted', async () => {
  const a = await room('searchone')
  const b = await room('searchtwo')
  const hit = await say(a.id, [
    { kind: 'text', text: 'We should migrate the "billing" service to Postgres' },
  ])
  await say(b.id, [{ kind: 'text', text: 'Postgres backups run nightly' }])
  await say(a.id, [
    { kind: 'tool', tool: 'x', args: 'postgres secret tool args', result: null, status: 'ok' },
  ])
  const all = (await get('/api/search/messages?q=postgres')).json().items
  expect(all).toHaveLength(2)
  expect(all[0]).toMatchObject({
    roomName: expect.any(String),
    snippet: expect.stringContaining('[['),
  })
  const scoped = (await get(`/api/search/messages?q=postgres&roomId=${a.id}`)).json().items
  expect(scoped).toHaveLength(1)
  expect(scoped[0]).toMatchObject({
    messageId: hit.id,
    roomId: a.id,
    author: { kind: 'agent', agentId: 'builder' },
    createdAt: hit.createdAt,
  })
  // FTS syntax from the user is plain text; the last word matches as a prefix.
  expect((await get('/api/search/messages?q=post*%20OR%20"')).json().items).toHaveLength(0)
  expect((await get('/api/search/messages?q=postg')).json().items).toHaveLength(2)
  expect((await get('/api/search/messages?q=')).json().items).toEqual([])
  expect((await get('/api/search/messages?q=postgres&limit=51')).statusCode).toBe(400)
  // Deleted messages leave the index.
  await ingest.submit({
    source: 'test',
    identity: 'delete',
    apply: ({ sqlite, now }) => deleteMessage(sqlite, a.id, hit.id, now),
  })
  expect((await get('/api/search/messages?q=postgres')).json().items).toHaveLength(1)
  // A streaming reply is indexed when it completes, not while it grows.
  await ingest.submit({
    source: 'test',
    identity: 'stream',
    apply: ({ sqlite, now }) =>
      storeMessage(
        sqlite,
        {
          id: 'streamer',
          roomId: a.id,
          author: { kind: 'agent', agentId: 'builder' },
          to: [],
          parts: [],
          refs: [],
          createdAt: now,
          streaming: true,
        },
        now,
      ),
  })
  await ingest.submit({
    source: 'test',
    identity: 'delta',
    apply: ({ sqlite, now }) => updateMessage(sqlite, a.id, 'streamer', 'zebrafish partial', now),
  })
  expect((await get('/api/search/messages?q=zebrafish')).json().items).toHaveLength(0)
  await ingest.submit({
    source: 'test',
    identity: 'done',
    apply: ({ sqlite, now }) => updateMessage(sqlite, a.id, 'streamer', null, now),
  })
  expect((await get('/api/search/messages?q=zebrafish')).json().items).toHaveLength(1)
})

test('export: markdown and json carry text, file and image references, redacted, no deleted', async () => {
  const a = await room('exports')
  await say(a.id, [{ kind: 'text', text: 'Hello team' }], { kind: 'you' })
  await say(a.id, [
    { kind: 'text', text: 'Use api_key=sk-abcdefghijklmnop123 for the call' },
    { kind: 'file', path: 'src/app.ts', added: 3, removed: 1 },
    { kind: 'image', mediaId: 'media-1' },
    { kind: 'tool', tool: 'terminal', args: 'rm -rf', result: null, status: 'ok' },
    { kind: 'thinking', text: 'private reasoning' },
  ])
  const gone = await say(a.id, [{ kind: 'text', text: 'deleted secret' }], { kind: 'you' })
  await ingest.submit({
    source: 'test',
    identity: 'del',
    apply: ({ sqlite, now }) => deleteMessage(sqlite, a.id, gone.id, now),
  })
  const md = await get(`/api/rooms/${a.id}/export.md`)
  expect(md.statusCode).toBe(200)
  expect(md.headers['content-type']).toContain('text/markdown')
  expect(md.headers['content-disposition']).toContain('attachment; filename="score-exports.md"')
  expect(md.body).toContain('# #exports')
  expect(md.body).toContain('Exported at:')
  expect(md.body).toContain('Members: lead, builder')
  expect(md.body).toContain('Hello team')
  expect(md.body).toContain('`src/app.ts`')
  expect(md.body).toContain('Image: media-1')
  expect(md.body).not.toContain('sk-abcdefghijklmnop123')
  expect(md.body).not.toContain('deleted secret')
  expect(md.body).not.toContain('private reasoning')
  expect(md.body).not.toContain('rm -rf')
  const json = (await get(`/api/rooms/${a.id}/export.json`)).json()
  expect(json.room.members).toEqual([
    { id: 'lead', name: 'lead' },
    { id: 'builder', name: 'builder' },
  ])
  expect(json.messages).toHaveLength(2)
  expect(json.messages[1]).toMatchObject({
    files: [{ path: 'src/app.ts', added: 3, removed: 1 }],
    images: [{ mediaId: 'media-1' }],
  })
  expect(JSON.stringify(json)).not.toContain('sk-abcdefghijklmnop123')
  expect((await get('/api/rooms/nope/export.md')).statusCode).toBe(404)
})

test('migration 0035 indexes the messages that already exist and keeps the room columns safe', () => {
  const dir2 = mkdtempSync(join(tmpdir(), 'score-conv-mig-'))
  try {
    const source = fileURLToPath(new URL('../../migrations/', import.meta.url))
    const names = readdirSync(source).sort()
    mkdirSync(join(dir2, 'migrations'))
    for (const name of names.filter((item) => item < '0035'))
      copyFileSync(join(source, name), join(dir2, 'migrations', name))
    const old = openDatabase(join(dir2, 'old.db'))
    migrate(old, join(dir2, 'migrations'))
    const at = '2026-01-01T00:00:00.000Z'
    old.sqlite
      .prepare(
        `INSERT INTO rooms (id, name, kind, lead_agent_id, members, created_at, updated_at)
         VALUES ('r1', '#old', 'room', NULL, '[]', ?, ?)`,
      )
      .run(at, at)
    const add = old.sqlite.prepare(
      `INSERT INTO messages (id, room_id, author_kind, author_agent_id, "to", parts, refs, streaming, created_at, updated_at, deleted_at)
       VALUES (?, 'r1', 'you', NULL, '[]', ?, '[]', ?, ?, ?, ?)`,
    )
    const text = (value: string) =>
      JSON.stringify([
        { kind: 'text', text: value },
        { kind: 'tool', tool: 't', args: 'zzz', result: null, status: 'ok' },
      ])
    add.run('m1', text('legacy pomegranate'), 0, at, at, null)
    add.run('m2', text('legacy deleted pomegranate'), 0, at, at, at)
    add.run('m3', text('legacy streaming pomegranate'), 1, at, at, null)
    copyFileSync(
      join(source, '0035_conversations.sql'),
      join(dir2, 'migrations', '0035_conversations.sql'),
    )
    migrate(old, join(dir2, 'migrations'))
    const hits = old.sqlite
      .prepare(
        "SELECT m.id FROM message_fts JOIN messages m ON m.rowid = message_fts.rowid WHERE message_fts MATCH 'pomegranate'",
      )
      .all()
    expect(hits).toEqual([{ id: 'm1' }])
    expect(
      old.sqlite
        .prepare("SELECT pinned, archived, project_id, tags FROM rooms WHERE id = 'r1'")
        .get(),
    ).toEqual({
      pinned: 0,
      archived: 0,
      project_id: null,
      tags: null,
    })
    old.close()
  } finally {
    rmSync(dir2, { recursive: true, force: true })
  }
})
