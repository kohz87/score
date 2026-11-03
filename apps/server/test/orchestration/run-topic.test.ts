import { afterEach, expect, test } from 'vitest'
import { insertRoom } from '../../src/domain/rooms.ts'
import { create, harness, type Harness } from './harness.ts'
import { agent, definition, edge, end, start, wfHarness } from '../workflows/wf-harness.ts'

// 3.23.0 (chats stage 3): a run started from a chat becomes a topic of that chat in the same transaction.
let h: Harness | undefined
afterEach(async () => {
  await h?.close()
  h = undefined
})

function chat(target: Harness, id = 'room-chat') {
  target.db.sqlite.exec('BEGIN')
  insertRoom(
    target.db.sqlite,
    {
      id,
      name: `Chat ${id}`,
      kind: 'room',
      leadAgentId: 'lead',
      members: ['lead', 'builder', 'reviewer'],
      routing: 'exchanges',
    },
    new Date().toISOString(),
  )
  target.db.sqlite.exec('COMMIT')
  return id
}

const topics = (target: Harness, roomId: string) =>
  target.rows<{ id: string; title: string; recipe_kind: string; recipe_ref: string }>(
    'SELECT id, title, recipe_kind, recipe_ref FROM jobs WHERE room_id = ? AND is_default = 0',
    roomId,
  )

test('an orchestration with a topic makes the run and its linked topic in one call', async () => {
  h = await harness()
  const roomId = chat(h)
  const made = await h.orch.create(
    create({ topic: { roomId, title: 'Release notes', exchangeBudget: 6 } }),
  )
  expect(made.topicId).toBeDefined()
  const rows = topics(h, roomId)
  expect(rows).toEqual([
    {
      id: made.topicId,
      title: 'Release notes',
      recipe_kind: 'orchestration',
      recipe_ref: made.orchestration.id,
    },
  ])
  // Without a topic nothing is made in any chat, and no topic id is returned.
  const plain = await h.orch.create(create())
  expect(plain.topicId).toBeUndefined()
  expect(topics(h, roomId)).toHaveLength(1)
})

test('a topic that can’t be made (no such chat) leaves no run behind', async () => {
  h = await harness()
  const before = h.rows('SELECT id FROM orchestrations').length
  await expect(
    h.orch.create(create({ topic: { roomId: 'room-missing', title: 'Nowhere' } })),
  ).rejects.toMatchObject({ status: 404 })
  expect(h.rows('SELECT id FROM orchestrations')).toHaveLength(before)
  expect(h.rows("SELECT id FROM rooms WHERE id LIKE 'room-orc-%'")).toHaveLength(0)
})

test('a recipe run with a topic links the topic to the run', async () => {
  const w = await wfHarness()
  h = w
  const roomId = chat(w)
  const id = await start(w, definition([agent('a'), end()], [edge('a', 'done')]), {
    topic: { roomId, title: 'Recipe topic' },
  })
  const rows = topics(w, roomId)
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ title: 'Recipe topic', recipe_kind: 'workflow', recipe_ref: id })
})
