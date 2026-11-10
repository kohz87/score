import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { migrate, openDatabase, type ScoreDb } from '../../src/db/index.ts'
import {
  chatEffortsOfAgent,
  chatEffortsOfRoom,
  effortForTurn,
  effortLevelsOf,
  setChatEffort,
} from '../../src/domain/chat-efforts.ts'

let dir: string
let db: ScoreDb
const NOW = '2026-11-10T01:00:00.000Z'

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'score-efforts-'))
  db = openDatabase(join(dir, 'score.db'))
  migrate(db, fileURLToPath(new URL('../../migrations/', import.meta.url)))
  db.tx((sqlite) => {
    sqlite
      .prepare(
        `INSERT INTO rooms (id, name, kind, members, created_at, updated_at, role, routing)
         VALUES ('room-1', 'Team room', 'room', '["builder","reviewer"]', 'now', 'now', 'room', 'exchanges')`,
      )
      .run()
    sqlite
      .prepare(
        `INSERT INTO jobs (id, room_id, title, session_scheme, exchange_budget, job_turn_limit, created_at, updated_at)
         VALUES ('job-1', 'room-1', 'Release notes 2.4', 'job', 8, 40, 'now', 'now')`,
      )
      .run()
  })
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

test('a Hermes agent takes Score’s levels; a coding agent its CLI’s', () => {
  expect(effortLevelsOf(db.sqlite, 'builder')).toContain('max')
  db.tx((sqlite) =>
    sqlite
      .prepare(
        `INSERT INTO coding_agents (id, name, runtime, workspace, permission, color, shape, created_at)
         VALUES ('coder', 'coder', 'codex', '/tmp', 'read-only', '#4FD1A5', 'circle', 'now')`,
      )
      .run(),
  )
  expect(effortLevelsOf(db.sqlite, 'coder')).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh'])
})

test('setting, listing and going back to the agent’s own', () => {
  const drafts = db.tx((sqlite) => setChatEffort(sqlite, 'room-1', 'reviewer', 'max', NOW))
  expect(drafts).toEqual([
    {
      type: 'effort.changed',
      data: { roomId: 'room-1', agentId: 'reviewer', effort: 'max', reason: 'person' },
    },
  ])
  db.tx((sqlite) => setChatEffort(sqlite, 'room-1', 'builder', 'high', NOW))
  expect(chatEffortsOfRoom(db.sqlite, 'room-1')).toEqual([
    { roomId: 'room-1', agentId: 'builder', effort: 'high' },
    { roomId: 'room-1', agentId: 'reviewer', effort: 'max' },
  ])
  expect(chatEffortsOfAgent(db.sqlite, 'reviewer')).toEqual([
    {
      roomId: 'room-1',
      roomName: 'Team room',
      roomKind: 'group',
      jobTitle: 'Release notes 2.4',
      effort: 'max',
    },
  ])
  db.tx((sqlite) => setChatEffort(sqlite, 'room-1', 'reviewer', null, NOW))
  expect(chatEffortsOfRoom(db.sqlite, 'room-1')).toHaveLength(1)
})

test('a turn runs at the chat’s effort and its reply carries the label', () => {
  db.tx((sqlite) => {
    setChatEffort(sqlite, 'room-1', 'builder', 'high', NOW)
    sqlite
      .prepare(
        `INSERT INTO messages (id, room_id, author_kind, "to", parts, refs, created_at, updated_at, streaming)
         VALUES ('m-1', 'room-1', 'you', '[]', '[]', '[]', 'now', 'now', 0)`,
      )
      .run()
    sqlite
      .prepare(
        `INSERT INTO message_runs (message_id, room_id, agent_id, chain_id, hop, turn_id, parent_message_id, input, agents, created_at)
         VALUES ('reply:t-1', 'room-1', 'builder', 'm-1', 0, 't-1', 'm-1', 'Fix it', '[]', 'now')`,
      )
      .run()
  })
  const chosen = db.tx((sqlite) =>
    effortForTurn(sqlite, { roomId: 'room-1', agentId: 'builder', turnId: 't-1' }),
  )
  expect(chosen).toEqual({ effort: 'high', drafts: [] })
  db.tx((sqlite) =>
    sqlite
      .prepare(
        `INSERT INTO messages (id, room_id, author_kind, author_agent_id, "to", parts, refs, created_at, updated_at, streaming)
         VALUES ('reply:t-1', 'room-1', 'agent', 'builder', '[]', '[]', '[]', 'now', 'now', 1)`,
      )
      .run(),
  )
  expect(db.sqlite.prepare("SELECT effort FROM messages WHERE id = 'reply:t-1'").get()).toEqual({
    effort: 'high',
  })
  expect(
    db.tx((sqlite) =>
      effortForTurn(sqlite, { roomId: 'room-1', agentId: 'reviewer', turnId: 'x' }),
    ),
  ).toEqual({ effort: null, drafts: [] })
})

test('a level the agent no longer takes goes back to its own, and says why', () => {
  db.tx((sqlite) => setChatEffort(sqlite, 'room-1', 'builder', 'ultra', NOW))
  const chosen = db.tx((sqlite) =>
    effortForTurn(sqlite, { roomId: 'room-1', agentId: 'builder', turnId: 't-2' }),
  )
  expect(chosen).toEqual({
    effort: null,
    drafts: [
      {
        type: 'effort.changed',
        data: { roomId: 'room-1', agentId: 'builder', effort: null, reason: 'model' },
      },
    ],
  })
  expect(chatEffortsOfRoom(db.sqlite, 'room-1')).toEqual([])
})
