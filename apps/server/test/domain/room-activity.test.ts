import type { Message } from '@score/contract'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { migrate, openDatabase, type ScoreDb } from '../../src/db/index.ts'
import { approvalDraft, approvalView, readApprovalRow } from '../../src/domain/approval-store.ts'
import {
  deriveRoomEvents,
  setRoomCompatibility,
  insertRoom,
  readRoom,
  storeMessage,
  updateMessage,
} from '../../src/domain/rooms.ts'
import { createIngest, type Ingest } from '../../src/hub/ingest.ts'

// PLAN 10.11: Room.activeAgents is who is busy in the room now, not who wrote lately.
let dir: string
let db: ScoreDb
let ingest: Ingest
let clock: number
const NOW = Date.parse('2026-10-19T10:00:00.000Z')
const iso = (ms = clock) => new Date(ms).toISOString()

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'score-room-activity-'))
  db = openDatabase(join(dir, 'score.db'))
  migrate(db, fileURLToPath(new URL('../../migrations/', import.meta.url)))
  clock = NOW
  ingest = createIngest(db, { clock: () => clock, deriveEvents: deriveRoomEvents })
  for (const id of ['r1', 'r2'])
    insertRoom(
      db.sqlite,
      { id, name: `#${id}`, kind: 'room', leadAgentId: 'lead', members: ['lead', 'builder'] },
      iso(),
    )
})
afterEach(async () => {
  setRoomCompatibility(null)
  await ingest.close()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const active = (roomId = 'r1') => readRoom(db.sqlite, roomId, iso()).activeAgents
function message(id: string, roomId: string, agentId: string, streaming: boolean, at = clock) {
  const value: Message = {
    id,
    roomId,
    author: { kind: 'agent', agentId },
    to: [],
    parts: [{ kind: 'text', text: id }],
    refs: [],
    createdAt: iso(at),
    streaming,
  }
  return value
}
const put = (value: Message) => storeMessage(db.sqlite, value, iso())

function approval(id: string, agentId: string, over: Record<string, unknown> = {}) {
  db.sqlite
    .prepare(
      `INSERT OR IGNORE INTO producers (id, profile, incarnation, pid, isolation, plugin_version, private_apis, token_hash,
        token_expires_at, created_at, last_seen_at, gateway_approvals)
       VALUES ('p1', ?, 'inc', 1, 'host', '1', '{}', 'hash', 0, ?, ?, 1)`,
    )
    .run(agentId, iso(), iso(clock + 60_000))
  const row = {
    id,
    origin: 'gateway',
    stage: 'human',
    target_kind: 'gateway_request',
    request_id: `req-${id}`,
    producer_id: 'p1',
    profile: agentId,
    phase: 'human_pending',
    status: 'pending',
    ...over,
  }
  db.sqlite
    .prepare(
      `INSERT INTO approvals (id, origin, stage, target_kind, request_id, producer_id, profile, session_key, surface,
        command, description, pattern_keys, choices, phase, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 's', 'cli', 'rm', 'd', '[]', '["once"]', ?, ?, ?, ?)`,
    )
    .run(
      row.id as string,
      row.origin as string,
      row.stage as string,
      row.target_kind as string,
      row.request_id as string,
      row.producer_id as string,
      row.profile as string,
      row.phase as string,
      row.status as string,
      iso(),
      iso(),
    )
}
// The card of an approval is stored as `approval:<id>`, as Score does.
const card = (_id: string, roomId: string, agentId: string, approvalId: string) =>
  put({
    ...message(`approval:${approvalId}`, roomId, agentId, false),
    parts: [{ kind: 'approval', approvalId }],
  })

test('a streaming reply makes its author active and completing it clears them', () => {
  put(message('m1', 'r1', 'builder', true))
  expect(active()).toEqual(['builder'])
  expect(active('r2')).toEqual([])
  updateMessage(db.sqlite, 'r1', 'm1', null, iso())
  expect(active()).toEqual([])
})

test('a reply that finished long ago, or nine minutes ago, does not count', () => {
  put(message('m1', 'r1', 'builder', false, NOW - 9 * 60_000))
  put(message('m2', 'r1', 'lead', false, NOW - 60 * 60_000))
  expect(active()).toEqual([])
})

test('deleted streaming messages do not count and the list is sorted by id', () => {
  put(message('m1', 'r1', 'lead', true))
  put(message('m2', 'r1', 'builder', true))
  put(message('m3', 'r1', 'lead', true))
  expect(active()).toEqual(['builder', 'lead'])
  db.sqlite.prepare("UPDATE messages SET deleted_at = ? WHERE id IN ('m2', 'm3')").run(iso())
  expect(active()).toEqual(['lead'])
})

test('a pending actionable approval counts: tied to this room, not to another, and with no room it counts', () => {
  approval('a1', 'builder')
  expect(active()).toEqual(['builder'])
  expect(active('r2')).toEqual(['builder'])
  card('c1', 'r2', 'builder', 'a1')
  expect(active('r2')).toEqual(['builder'])
  expect(active('r1')).toEqual([])
})

test('an approval stops counting once it is decided, withdrawn or no longer actionable', () => {
  approval('a1', 'builder')
  card('c1', 'r1', 'builder', 'a1')
  expect(active()).toEqual(['builder'])
  db.sqlite.prepare("UPDATE approvals SET phase = 'decided', status = 'approved'").run()
  expect(active()).toEqual([])
  approval('a2', 'lead', { request_id: 'x' })
  db.sqlite.prepare("UPDATE approvals SET request_id = NULL WHERE id = 'a2'").run()
  expect(active()).toEqual([])
})

test('an approval for someone who is not a member does not count', () => {
  approval('a1', 'reviewer')
  expect(active()).toEqual([])
})

test('a room update goes out when an approval opens or closes', async () => {
  approval('a1', 'builder')
  db.sqlite.prepare("UPDATE approvals SET phase = 'withdrawn', status = 'withdrawn'").run()
  const drafts = (open: boolean) =>
    ingest.submit({
      source: 'test',
      identity: `ap-${open}`,
      apply: ({ sqlite, now }) => {
        if (open)
          sqlite.prepare("UPDATE approvals SET phase = 'human_pending', status = 'pending'").run()
        else sqlite.prepare("UPDATE approvals SET phase = 'withdrawn', status = 'withdrawn'").run()
        return approvalDraft(sqlite, 'a1', { now: Date.parse(now) })
      },
    })
  const rooms = () =>
    db.sqlite
      .prepare("SELECT data FROM events WHERE type = 'room.upserted' ORDER BY seq")
      .all()
      .map((row) => JSON.parse(String(row.data)) as { id: string; activeAgents: string[] })
  await drafts(true)
  expect(
    rooms()
      .filter((room) => room.activeAgents.includes('builder'))
      .map((r) => r.id),
  ).toEqual(['r1', 'r2'])
  const before = rooms().length
  await drafts(false)
  expect(
    rooms()
      .slice(before)
      .map((room) => room.activeAgents),
  ).toEqual([[], []])
})

const roomEvents = () =>
  db.sqlite
    .prepare("SELECT data FROM events WHERE type = 'room.upserted' ORDER BY seq")
    .all()
    .map((row) => JSON.parse(String(row.data)) as { id: string; activeAgents: string[] })

test('completing or deleting a streaming reply sends the room update that clears its author', async () => {
  await ingest.submit({
    source: 'test',
    identity: 'start',
    apply: ({ sqlite, now }) => [
      ...storeMessage(sqlite, message('m1', 'r1', 'builder', true), now),
      ...storeMessage(sqlite, message('m2', 'r1', 'lead', true), now),
    ],
  })
  expect(roomEvents().at(-1)).toMatchObject({ id: 'r1', activeAgents: ['builder', 'lead'] })
  await ingest.submit({
    source: 'test',
    identity: 'finish',
    apply: ({ sqlite, now }) => updateMessage(sqlite, 'r1', 'm1', null, now),
  })
  expect(roomEvents().at(-1)).toMatchObject({ id: 'r1', activeAgents: ['lead'] })
  await ingest.submit({
    source: 'test',
    identity: 'delete',
    apply: ({ sqlite, now }) => {
      sqlite.prepare("UPDATE messages SET deleted_at = ? WHERE id = 'm2'").run(now)
      return [{ type: 'message.deleted', data: { roomId: 'r1', messageId: 'm2' } }]
    },
  })
  expect(roomEvents().at(-1)).toMatchObject({ id: 'r1', activeAgents: [] })
  // A completion that changes nobody's state sends nothing extra.
  const count = roomEvents().length
  await ingest.submit({
    source: 'test',
    identity: 'quiet',
    apply: ({ sqlite, now }) => [
      ...storeMessage(sqlite, message('m3', 'r1', 'lead', true), now),
      ...storeMessage(sqlite, message('m4', 'r1', 'lead', true), now),
    ],
  })
  const afterStart = roomEvents().length
  await ingest.submit({
    source: 'test',
    identity: 'quiet-finish',
    apply: ({ sqlite, now }) => updateMessage(sqlite, 'r1', 'm3', null, now),
  })
  expect(roomEvents()).toHaveLength(afterStart)
  expect(afterStart).toBeGreaterThan(count)
})

test('a Score run approval belongs to the room its run answers in, for the sidebar and for the approval itself', () => {
  const at = iso()
  db.sqlite
    .prepare(
      `INSERT INTO runs (id, profile, origin, status, started_at, updated_at) VALUES ('run-1', 'builder', 'score', 'running', ?, ?)`,
    )
    .run(at, at)
  put(message('q1', 'r1', 'lead', false))
  db.sqlite
    .prepare(
      `INSERT INTO message_runs (message_id, run_id, room_id, agent_id, chain_id, hop, turn_id, parent_message_id, input, agents, state, created_at)
       VALUES ('q1-reply', 'run-1', 'r1', 'builder', 'q1', 0, 't1', 'q1', 'x', '[]', 'active', ?)`,
    )
    .run(at)
  db.sqlite
    .prepare(
      `INSERT INTO approvals (id, origin, stage, target_kind, run_id, request_id, profile, session_key, surface, command, description,
        pattern_keys, choices, phase, status, created_at, updated_at)
       VALUES ('a1', 'score-run', 'human', 'run_request', 'run-1', 'req', 'builder', 'run-1', 'cli', 'rm', 'd', '[]', '["once"]',
        'human_pending', 'pending', ?, ?)`,
    )
    .run(at, at)
  const view = approvalView(db.sqlite, readApprovalRow(db.sqlite, 'a1')!, { now: clock })
  expect(view.actionable).toBe(true)
  expect(view.refs).toEqual([
    { kind: 'run', runId: 'run-1' },
    { kind: 'room', roomId: 'r1' },
  ])
  expect(active('r1')).toEqual(['builder'])
  expect(active('r2')).toEqual([])
})

test('an approval that a compatibility check switched off is not busy, as the approvals API says', async () => {
  approval('a1', 'builder')
  const row = () => readApprovalRow(db.sqlite, 'a1')!
  expect(active()).toEqual(['builder'])
  setRoomCompatibility(() => ['gateway-approvals'])
  expect(
    approvalView(db.sqlite, row(), { now: clock, disabled: ['gateway-approvals'] }).actionable,
  ).toBe(false)
  expect(active()).toEqual([])
  setRoomCompatibility(() => [])
  expect(approvalView(db.sqlite, row(), { now: clock, disabled: [] }).actionable).toBe(true)
  expect(active()).toEqual(['builder'])
})
