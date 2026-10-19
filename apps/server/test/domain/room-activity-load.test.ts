import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { migrate, openDatabase, type ScoreDb } from '../../src/db/index.ts'
import { approvalDraft } from '../../src/domain/approval-store.ts'
import {
  deriveRoomEvents,
  insertRoom,
  readAllRooms,
  refreshRooms,
  staleRoomIds,
} from '../../src/domain/rooms.ts'
import { createIngest, type Ingest } from '../../src/hub/ingest.ts'

// PLAN 10.11 performance: the busy-now read must not grow with rooms x approvals, and an approval event that
// changes nobody's state must send no room update.
let dir: string
let db: ScoreDb
let ingest: Ingest
const NOW = Date.parse('2026-10-19T10:00:00.000Z')
const iso = (ms = NOW) => new Date(ms).toISOString()
const agents = ['lead', 'builder', 'reviewer', 'designer', 'a5', 'a6', 'a7', 'a8']

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'score-room-load-'))
  db = openDatabase(join(dir, 'score.db'))
  migrate(db, fileURLToPath(new URL('../../migrations/', import.meta.url)))
  ingest = createIngest(db, { clock: () => NOW, deriveEvents: deriveRoomEvents })
  const sqlite = db.sqlite
  sqlite.exec('BEGIN')
  for (let index = 0; index < 300; index++)
    insertRoom(
      sqlite,
      {
        id: `room-${index}`,
        name: `#room-${index}`,
        kind: 'room',
        leadAgentId: agents[index % agents.length]!,
        members: [agents[index % agents.length]!, agents[(index + 3) % agents.length]!],
      },
      iso(),
    )
  // Plenty of history: the streaming read must not scan it.
  const message = sqlite.prepare(
    `INSERT INTO messages (id, room_id, author_kind, author_agent_id, "to", parts, refs, streaming, created_at, updated_at)
     VALUES (?, ?, 'agent', ?, '[]', '[]', '[]', ?, ?, ?)`,
  )
  for (let index = 0; index < 6000; index++)
    message.run(`old-${index}`, `room-${index % 300}`, agents[index % 8]!, 0, iso(), iso())
  for (let index = 0; index < 20; index++)
    message.run(`live-${index}`, `room-${index * 7}`, agents[(index * 7) % 8]!, 1, iso(), iso())
  sqlite
    .prepare(
      `INSERT INTO producers (id, profile, incarnation, pid, isolation, plugin_version, private_apis, token_hash,
        token_expires_at, created_at, last_seen_at, gateway_approvals)
       VALUES ('p1', 'lead', 'inc', 1, 'host', '1', '{}', 'hash', 0, ?, ?, 1)`,
    )
    .run(iso(), iso(NOW + 60_000))
  const approval = sqlite.prepare(
    `INSERT INTO approvals (id, origin, stage, target_kind, request_id, producer_id, profile, session_key, surface,
       command, description, pattern_keys, choices, phase, status, created_at, updated_at)
     VALUES (?, 'gateway', 'human', 'gateway_request', ?, 'p1', ?, 's', 'cli', 'rm', 'd', '[]', '["once"]',
       'human_pending', 'pending', ?, ?)`,
  )
  for (let index = 0; index < 40; index++)
    approval.run(`ap-${index}`, `req-${index}`, agents[index % 4]!, iso(), iso())
  sqlite.exec('COMMIT')
})
afterEach(async () => {
  await ingest.close()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const timed = <T>(work: () => T): [T, number] => {
  const start = performance.now()
  const result = work()
  return [result, performance.now() - start]
}

test('reading 300 rooms and one sweep stay fast with 40 pending approvals and 20 streaming replies', () => {
  const [rooms, list] = timed(() => readAllRooms(db.sqlite, iso()))
  expect(rooms).toHaveLength(300)
  expect(rooms.filter((room) => room.activeAgents.length > 0).length).toBeGreaterThan(100)
  const [stale, sweep] = timed(() => staleRoomIds(db.sqlite, iso()))
  expect(stale.length).toBeGreaterThan(100)
  // Measured on the 14-core dev VM (see the report); the budgets leave several times that.
  expect(list).toBeLessThan(150)
  expect(sweep).toBeLessThan(50)
})

test('once the busy sets are recorded, a sweep and an approval event that changes nobody send nothing', async () => {
  await ingest.submit({
    source: 'test',
    identity: 'record',
    apply: ({ sqlite, now }) => refreshRooms(sqlite, now),
  })
  expect(staleRoomIds(db.sqlite, iso())).toEqual([])
  const count = () =>
    db.sqlite.prepare("SELECT count(*) AS n FROM events WHERE type = 'room.upserted'").get()
  const before = count()
  await ingest.submit({
    source: 'test',
    identity: 'noise',
    apply: ({ sqlite, now }) => approvalDraft(sqlite, 'ap-1', { now: Date.parse(now) }),
  })
  expect(count()).toEqual(before)
  const [, sweep] = timed(() => staleRoomIds(db.sqlite, iso()))
  expect(sweep).toBeLessThan(50)
})
