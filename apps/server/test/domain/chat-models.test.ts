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
import { roomChanged } from '../../src/domain/rooms-write.ts'

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

test('taking an agent out of the chat drops its overrides at once and tells the chat; deleting the chat drops them too', () => {
  const drafts = db.tx((sqlite) => {
    setChatModel(sqlite, 'room-1', 'reviewer', DEEP, NOW)
    setChatModel(sqlite, 'room-1', 'builder', DEEP, NOW)
    sqlite
      .prepare(
        "INSERT INTO chat_efforts (room_id, agent_id, effort, set_at) VALUES ('room-1', 'reviewer', 'max', ?)",
      )
      .run(NOW)
    sqlite.prepare(`UPDATE rooms SET members = '["builder"]' WHERE id = 'room-1'`).run()
    return roomChanged(sqlite, 'room-1', NOW)
  })
  expect(drafts.filter((draft) => draft.type !== 'room.upserted')).toEqual([
    {
      type: 'model.changed',
      data: { roomId: 'room-1', agentId: 'reviewer', model: null, label: null, reason: 'member' },
    },
    {
      type: 'effort.changed',
      data: { roomId: 'room-1', agentId: 'reviewer', effort: null, reason: 'member' },
    },
  ])
  expect(chatModelsOfRoom(db.sqlite, 'room-1').map((row) => row.agentId)).toEqual(['builder'])
  // Added again, it starts from its own.
  db.tx((sqlite) => {
    sqlite.prepare(`UPDATE rooms SET members = '["builder","reviewer"]' WHERE id = 'room-1'`).run()
    roomChanged(sqlite, 'room-1', NOW)
  })
  expect(chatModelsOfRoom(db.sqlite, 'room-1').map((row) => row.agentId)).toEqual(['builder'])
  db.tx((sqlite) => {
    sqlite
      .prepare(
        `INSERT INTO rooms (id, name, kind, members, created_at, updated_at, role, routing)
         VALUES ('room-2', 'Other', 'room', '["builder"]', ?, ?, 'room', 'exchanges')`,
      )
      .run(NOW, NOW)
    setChatModel(sqlite, 'room-2', 'builder', DEEP, NOW)
    // A room's own rows go first, as room deletion does them.
    sqlite.prepare("DELETE FROM jobs WHERE room_id = 'room-2'").run()
    sqlite.prepare("DELETE FROM rooms WHERE id = 'room-2'").run()
  })
  expect(chatModelsOfRoom(db.sqlite, 'room-2')).toEqual([])
})

test('a retry runs on what the turn it repeats ran on, its own included', () => {
  reserve('t-5')
  // The first attempt ran on the agent's own: decided, nothing recorded.
  db.tx((sqlite) => modelForTurn(sqlite, { roomId: 'room-1', agentId: 'builder', turnId: 't-5' }))
  // A model is chosen afterwards; a turn marked as decided keeps its own.
  db.tx((sqlite) => setChatModel(sqlite, 'room-1', 'builder', DEEP, NOW))
  db.tx((sqlite) =>
    sqlite
      .prepare(
        `INSERT INTO message_runs (message_id, room_id, agent_id, chain_id, hop, turn_id, parent_message_id, input, agents, created_at, model_chosen)
         VALUES ('reply:t-6', 'room-1', 'builder', 'm-1', 0, 't-6', 'm-1', 'Fix it', '[]', 'now', 1)`,
      )
      .run(),
  )
  db.tx((sqlite) => modelForTurn(sqlite, { roomId: 'room-1', agentId: 'builder', turnId: 't-6' }))
  expect(turnRoute('t-6')).toEqual({ model: null, provider: null })
  expect(
    db.sqlite.prepare("SELECT model_chosen FROM message_runs WHERE turn_id = 't-5'").get(),
  ).toEqual({
    model_chosen: 1,
  })
})
