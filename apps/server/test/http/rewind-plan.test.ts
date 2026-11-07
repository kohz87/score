import { RewindPlanSchema } from '@score/contract'
import { expect, test } from 'vitest'
import {
  answer,
  ask,
  createRoom,
  db,
  fake,
  get,
  rewind,
  setupRewindTest,
} from './rewind-helpers.ts'

setupRewindTest()

// audit4-c 4: a turn that never reached Hermes (no run id) is not a turn to rewind.
test('turns that never reached Hermes are not counted in the rewind plan', async () => {
  const room = await createRoom()
  const first = await ask(room.id, 'first', ['builder'])
  await answer(room.id, first.id, 'builder')
  const second = await ask(room.id, 'second', ['builder'])
  const reply = await answer(room.id, second.id, 'builder')
  const before = RewindPlanSchema.parse(
    (await get(`/api/rooms/${room.id}/messages/${second.id}/rewind-plan`)).json(),
  )
  expect(before.agents.map((a) => [a.agentId, a.turns])).toEqual([['builder', 1]])
  // The same turn failed before Hermes ever saw it.
  db.sqlite.prepare('UPDATE message_runs SET run_id = NULL WHERE message_id = ?').run(reply)
  const after = RewindPlanSchema.parse(
    (await get(`/api/rooms/${room.id}/messages/${second.id}/rewind-plan`)).json(),
  )
  expect(after.agents).toEqual([])
})

// audit4-c 6: a room that continues an outside session rewinds that session.
test('a continued outside session is the one that gets rewound', async () => {
  const room = await createRoom()
  db.sqlite
    .prepare(
      `INSERT INTO room_sessions (room_id, agent_id, session_id, mode) VALUES (?, 'builder', 'ext-telegram-1', 'same_session')`,
    )
    .run(room.id)
  const first = await ask(room.id, 'first', ['builder'])
  await answer(room.id, first.id, 'builder')
  const response = await rewind(room.id, first.id)
  expect(response.statusCode).toBe(200)
  expect(fake().rewinds.map((item) => [item.agentId, item.sessionId, item.turns])).toEqual([
    ['builder', 'ext-telegram-1', 1],
  ])
})
