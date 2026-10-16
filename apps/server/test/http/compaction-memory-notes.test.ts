import { RoomSchema, StreamEventSchema } from '@score/contract'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { buildApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { migrate, openDatabase, type ScoreDb } from '../../src/db/index.ts'
import { compactingSessions } from '../../src/domain/room-rewinding.ts'
import { createHermesPort, type HermesPort } from '../../src/hermes/index.ts'
import { createIngest, type Ingest } from '../../src/hub/ingest.ts'
import { parseNote } from '../../src/knowledge/note.ts'
import { KnowledgeVault } from '../../src/knowledge/vault.ts'
import { FakeScheduler } from '../hermes/fake-scheduler.ts'

// PLAN 8.2: a compaction's summary becomes a memory note in a real (temporary) vault.
let dir: string
let db: ScoreDb
let ingest: Ingest
let port: HermesPort
let vault: KnowledgeVault
let app: ReturnType<typeof buildApp>
let headers: { 'x-score-client': string; cookie: string }
const scheduler = new FakeScheduler()

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'score-memory-'))
  db = openDatabase(join(dir, 'score.db'))
  migrate(db, fileURLToPath(new URL('../../migrations/', import.meta.url)))
  const clock = () => Date.UTC(2026, 9, 16, 2, 0, 0)
  ingest = createIngest(db, { clock })
  port = createHermesPort(loadConfig({ SCORE_MODE: 'fake', SCORE_FAKE_LOOP: 'false' }), {
    db,
    scheduler,
  })
  vault = new KnowledgeVault({
    vault: join(dir, 'vault'),
    db,
    emit: () => undefined,
    watch: false,
    stateDir: join(dir, 'state'),
  })
  await vault.start()
  app = buildApp({
    config: loadConfig({ SCORE_MODE: 'fake' }),
    logger: false,
    db,
    ingest,
    port,
    clock,
    knowledge: vault,
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
})
afterEach(async () => {
  vi.restoreAllMocks()
  compactingSessions.clear()
  await port.stop()
  await app.close()
  await vault.close()
  await ingest.close()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const send = (method: 'POST' | 'PUT', url: string, payload: object) =>
  app.inject({ method, url, headers, payload })
async function room(name = 'launch') {
  const response = await send('POST', '/api/rooms', {
    name,
    leadAgentId: 'lead',
    members: ['lead', 'builder'],
  })
  if (response.statusCode !== 200) throw new Error(response.body)
  return RoomSchema.parse(response.json())
}
const compacted = () =>
  db.sqlite
    .prepare("SELECT seq, ts, type, data FROM events WHERE type = 'session.compacted' ORDER BY seq")
    .all()
    .map((row) =>
      StreamEventSchema.parse({ ...row, data: JSON.parse(String(row.data)) as unknown }),
    )
async function compact(roomId: string, agent = 'builder') {
  const before = compacted().length
  const accepted = await send('POST', `/api/agents/${agent}/sessions/score-${roomId}-${agent}/compact`, {})
  expect(accepted.statusCode).toBe(202)
  await vi.waitFor(() => expect(compacted()).toHaveLength(before + 1), { timeout: 3000 })
  return compacted().at(-1)!.data as { status: string; memoryNote: string | null }
}

test('compacting a room saves the summary as a dated memory note and reports its path', async () => {
  const r = await room()
  const event = await compact(r.id)
  expect(event).toMatchObject({
    status: 'compacted',
    memoryNote: 'Memory/builder/2026/10/2026-10-16 launch.md',
  })
  const note = parseNote(readFileSync(join(dir, 'vault', event.memoryNote!), 'utf8'))
  expect(note.frontmatter).toMatchObject({
    agent: 'builder',
    room: '#launch',
    session: `score-${r.id}-builder`,
    weight: 3,
    source: 'compaction',
  })
  expect(note.body).toContain('## Goal')
  const index = readFileSync(join(dir, 'vault/Memory/builder/2026/10/index.md'), 'utf8')
  expect(index).toContain('[[Memory/builder/2026/10/2026-10-16 launch|2026-10-16 launch]]')
})

test('the setting turns memory notes off, and a compaction then writes nothing', async () => {
  expect(((await app.inject({ method: 'GET', url: '/api/knowledge', headers })).json() as { memoryNotes: boolean }).memoryNotes).toBe(true)
  const off = await send('PUT', '/api/knowledge/settings', { memoryNotes: false })
  expect(off.json()).toMatchObject({ memoryNotes: false, agentAccess: true })
  const r = await room()
  expect(await compact(r.id)).toMatchObject({ status: 'compacted', memoryNote: null })
  expect(await vault.tree().then((tree) => JSON.stringify(tree))).not.toContain('Memory')
  expect((await send('PUT', '/api/knowledge/settings', {})).statusCode).toBe(400)
})

test('a vault that refuses the note does not break the compaction', async () => {
  const r = await room()
  vi.spyOn(vault, 'writeNote').mockRejectedValue(new Error('disk full'))
  expect(await compact(r.id)).toMatchObject({ status: 'compacted', memoryNote: null })
})
