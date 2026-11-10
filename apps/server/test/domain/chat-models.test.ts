import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { migrate, openDatabase, type ScoreDb } from '../../src/db/index.ts'
import {
  chatModelsOfAgent,
  chatModelsOfRoom,
  modelForTurn,
  setChatModel,
} from '../../src/domain/chat-models.ts'
import { storeMessage } from '../../src/domain/rooms.ts'

let dir: string
let db: ScoreDb
const NOW = '2026-11-10T01:00:00.000Z'
const DEEP = { model: 'example-large', provider: 'demo', label: 'deep' }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'score-chat-models-'))
  db = openDatabase(join(dir, 'score.db'))
  migrate(db, fileURLToPath(new URL('../../migrations/', import.meta.url)))
  db.tx((sqlite) => {
    sqlite
      .prepare(
        `INSERT INTO rooms (id, name, kind, members, created_at, updated_at, role, routing)
         VALUES ('room-1', 'Team room', 'room', '["builder","reviewer"]', '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z', 'room', 'exchanges')`,
      )
      .run()
    sqlite
      .prepare(
        `INSERT INTO messages (id, room_id, author_kind, "to", parts, refs, created_at, updated_at, streaming)
         VALUES ('m-1', 'room-1', 'you', '[]', '[]', '[]', '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z', 0)`,
      )
      .run()
  })
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const reserve = (turnId: string, agentId = 'builder', model: string | null = null) =>
  db.tx((sqlite) =>
    sqlite
      .prepare(
        `INSERT INTO message_runs (message_id, room_id, agent_id, chain_id, hop, turn_id, parent_message_id, input, model, agents, created_at)
         VALUES (?, 'room-1', ?, 'm-1', 0, ?, 'm-1', 'Fix it', ?, '[]', 'now')`,
      )
      .run(`reply:${turnId}`, agentId, turnId, model),
  )
const turnRoute = (turnId: string) =>
  db.sqlite.prepare('SELECT model, provider FROM message_runs WHERE turn_id = ?').get(turnId)

test('setting, listing and going back to the agent’s own; Undo gets what was replaced', () => {
  const first = db.tx((sqlite) => setChatModel(sqlite, 'room-1', 'reviewer', DEEP, NOW))
  expect(first).toEqual({
    replaced: null,
    drafts: [
      {
        type: 'model.changed',
        data: {
          roomId: 'room-1',
          agentId: 'reviewer',
          model: 'example-large',
          label: 'deep',
          reason: 'person',
        },
      },
    ],
  })
  const second = db.tx((sqlite) =>
    setChatModel(
      sqlite,
      'room-1',
      'reviewer',
      { model: 'free-model', provider: null, label: 'free-model' },
      NOW,
    ),
  )
  expect(second.replaced).toEqual({ roomId: 'room-1', agentId: 'reviewer', ...DEEP })
  expect(chatModelsOfRoom(db.sqlite, 'room-1')).toEqual([
    {
      roomId: 'room-1',
      agentId: 'reviewer',
      model: 'free-model',
      provider: null,
      label: 'free-model',
    },
  ])
  expect(chatModelsOfAgent(db.sqlite, 'reviewer')).toEqual([
    {
      roomId: 'room-1',
      roomName: 'Team room',
      roomKind: 'group',
      jobTitle: null,
      model: 'free-model',
      label: 'free-model',
    },
  ])
  db.tx((sqlite) => setChatModel(sqlite, 'room-1', 'reviewer', null, NOW))
  expect(chatModelsOfRoom(db.sqlite, 'room-1')).toEqual([])
})

test('a turn runs on the chat’s model, recorded on the turn, and its reply carries the label', () => {
  db.tx((sqlite) => setChatModel(sqlite, 'room-1', 'builder', DEEP, NOW))
  reserve('t-1')
  expect(
    db.tx((sqlite) =>
      modelForTurn(sqlite, { roomId: 'room-1', agentId: 'builder', turnId: 't-1' }),
    ),
  ).toEqual({ drafts: [] })
  expect(turnRoute('t-1')).toEqual({ model: 'example-large', provider: 'demo' })
  const drafts = db.tx((sqlite) =>
    storeMessage(
      sqlite,
      {
        id: 'reply:t-1',
        roomId: 'room-1',
        author: { kind: 'agent', agentId: 'builder' },
        to: [],
        parts: [],
        createdAt: NOW,
        streaming: true,
        refs: [],
      },
      NOW,
    ),
  )
  const created = drafts.find((draft) => draft.type === 'message.created') as {
    data: { model?: string }
  }
  expect(created.data.model).toBe('example-large')
  // An agent with no chat model runs on its own: nothing recorded.
  reserve('t-2', 'reviewer')
  db.tx((sqlite) => modelForTurn(sqlite, { roomId: 'room-1', agentId: 'reviewer', turnId: 't-2' }))
  expect(turnRoute('t-2')).toEqual({ model: null, provider: null })
})

test('a turn that already names a model (Try another, a retry) keeps it', () => {
  db.tx((sqlite) => setChatModel(sqlite, 'room-1', 'builder', DEEP, NOW))
  reserve('t-3', 'builder', 'other-model')
  db.tx((sqlite) => modelForTurn(sqlite, { roomId: 'room-1', agentId: 'builder', turnId: 't-3' }))
  expect(turnRoute('t-3')).toEqual({ model: 'other-model', provider: null })
})

test('an agent taken out of the chat goes back to its own, and the chat is told', () => {
  db.tx((sqlite) => {
    setChatModel(sqlite, 'room-1', 'reviewer', DEEP, NOW)
    sqlite.prepare(`UPDATE rooms SET members = '["builder"]' WHERE id = 'room-1'`).run()
  })
  reserve('t-4', 'reviewer')
  expect(
    db.tx((sqlite) =>
      modelForTurn(sqlite, { roomId: 'room-1', agentId: 'reviewer', turnId: 't-4' }),
    ),
  ).toEqual({
    drafts: [
      {
        type: 'model.changed',
        data: { roomId: 'room-1', agentId: 'reviewer', model: null, label: null, reason: 'member' },
      },
    ],
  })
  expect(chatModelsOfRoom(db.sqlite, 'room-1')).toEqual([])
  expect(turnRoute('t-4')).toEqual({ model: null, provider: null })
})
