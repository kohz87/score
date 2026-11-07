import {
  RewindPlanSchema,
  RewindResponseSchema,
  RoomVersionDetailSchema,
  RoomVersionsSchema,
} from '@score/contract'
import { expect, test, vi } from 'vitest'
import { rewindingRooms, restoreRoomHolds } from '../../src/domain/room-rewinding.ts'
import {
  answer,
  ask,
  createRoom,
  db,
  events,
  extraTurn,
  fake,
  get,
  rewind,
  setupRewindTest,
  visible,
} from './rewind-helpers.ts'

setupRewindTest()

test("a rewind counts each agent's turns from the message on (hand-offs, retries), hides the rest as a version and asks Hermes once", async () => {
  const room = await createRoom()
  const first = await ask(room.id, 'first', ['builder'])
  await answer(room.id, first.id, 'builder')
  const second = await ask(room.id, 'second', ['builder', 'reviewer'])
  const builderReply = await answer(room.id, second.id, 'builder')
  const reviewerReply = await answer(room.id, second.id, 'reviewer')
  const retry = await extraTurn(room.id, second.id, 'builder')
  const handoff = await extraTurn(room.id, second.id, 'lead', 2)
  const rewinds = vi.spyOn(fake(), 'rewindSession')

  const plan = RewindPlanSchema.parse(
    (await get(`/api/rooms/${room.id}/messages/${second.id}/rewind-plan`)).json(),
  )
  expect(plan).toEqual({
    hiddenCount: 5,
    blocked: null,
    agents: [
      { agentId: 'builder', turns: 2, cannot: null },
      { agentId: 'lead', turns: 1, cannot: null },
      { agentId: 'reviewer', turns: 1, cannot: null },
    ],
  })
  rewinds.mockClear()
  const response = await rewind(room.id, second.id)
  expect(response.statusCode).toBe(200)
  const body = RewindResponseSchema.parse(response.json())
  expect(body.rewound).toEqual([
    { agentId: 'builder', turnsUndone: 2 },
    { agentId: 'lead', turnsUndone: 1 },
    { agentId: 'reviewer', turnsUndone: 1 },
  ])
  expect(body.skipped).toEqual([])
  expect(body.version).toMatchObject({
    anchorId: second.id,
    mode: 'delete',
    hiddenCount: 5,
    number: 1,
    count: 1,
    replacedBy: null,
  })
  expect(
    rewinds.mock.calls
      .filter(([call]) => !call.dryRun)
      .map(([call]) => [call.agentId, call.sessionId, call.turns]),
  ).toEqual([
    ['builder', `score-${room.id}-builder`, 2],
    ['lead', `score-${room.id}-lead`, 1],
    ['reviewer', `score-${room.id}-reviewer`, 1],
  ])
  // Everything from the message on is gone from the room; the first exchange stays.
  expect(await visible(room.id)).toHaveLength(2)
  const types = events().map((event) => event.type)
  expect(types.filter((type) => type === 'message.deleted')).toHaveLength(5)
  expect(types.indexOf('room.version.created')).toBeGreaterThan(
    types.lastIndexOf('message.deleted'),
  )

  const detail = RoomVersionDetailSchema.parse(
    (await get(`/api/rooms/${room.id}/versions/${second.id}`)).json(),
  )
  expect(detail.items.map((item) => item.id)).toEqual([
    second.id,
    builderReply,
    reviewerReply,
    retry,
    handoff,
  ])
  const list = RoomVersionsSchema.parse((await get(`/api/rooms/${room.id}/versions`)).json())
  expect(list.items.map((item) => item.anchorId)).toEqual([second.id])
  expect((await get(`/api/rooms/${room.id}/versions/nope`)).statusCode).toBe(404)

  // Idempotent: repeating returns the stored result and never asks Hermes again.
  rewinds.mockClear()
  const again = await rewind(room.id, second.id)
  expect(again.statusCode).toBe(200)
  expect(RewindResponseSchema.parse(again.json()).version.id).toBe(body.version.id)
  expect(rewinds.mock.calls.filter(([call]) => !call.dryRun)).toEqual([])
  expect(events().filter((event) => event.type === 'room.version.created')).toHaveLength(1)

  // The turns already rewound are not counted by a later rewind of an earlier message.
  const earlier = await rewind(room.id, first.id)
  expect(RewindResponseSchema.parse(earlier.json()).rewound).toEqual([
    { agentId: 'builder', turnsUndone: 1 },
  ])
})

test('nothing is hidden unless every rewind worked; Hide in Score only skips Hermes', async () => {
  const room = await createRoom()
  const message = await ask(room.id, 'go', ['builder', 'reviewer'])
  await answer(room.id, message.id, 'builder')
  await answer(room.id, message.id, 'reviewer')
  fake().rewindSkips.set('reviewer', 'compressed')
  const plan = RewindPlanSchema.parse(
    (await get(`/api/rooms/${room.id}/messages/${message.id}/rewind-plan`)).json(),
  )
  expect(plan.agents.map((agent) => [agent.agentId, agent.cannot])).toEqual([
    ['builder', null],
    ['reviewer', 'compressed'],
  ])
  const refused = await rewind(room.id, message.id)
  expect(refused.statusCode).toBe(409)
  expect(refused.json()).toMatchObject({
    error: {
      code: 'rewind_incomplete',
      details: { skipped: [{ agentId: 'reviewer', reason: 'compressed' }], rewound: [] },
    },
  })
  expect(await visible(room.id)).toHaveLength(3)
  expect(fake().rewinds).toEqual([])

  const scoreOnly = await rewind(room.id, message.id, { mode: 'delete', scoreOnly: true })
  expect(scoreOnly.statusCode).toBe(200)
  expect(RewindResponseSchema.parse(scoreOnly.json())).toMatchObject({
    rewound: [],
    skipped: [
      { agentId: 'builder', reason: 'score_only' },
      { agentId: 'reviewer', reason: 'score_only' },
    ],
  })
  expect(fake().rewinds).toEqual([])
  expect(await visible(room.id)).toHaveLength(0)
})

test('a failure after the first agent keeps it rewound and counted once on retry', async () => {
  const room = await createRoom()
  const message = await ask(room.id, 'go', ['builder', 'reviewer'])
  await answer(room.id, message.id, 'builder')
  await answer(room.id, message.id, 'reviewer')
  const real = fake().rewindSession.bind(fake())
  vi.spyOn(fake(), 'rewindSession').mockImplementation(async (req) =>
    req.agentId === 'reviewer' && !req.dryRun
      ? { status: 'skipped', reason: 'no_answer' }
      : real(req),
  )
  const failed = await rewind(room.id, message.id)
  expect(failed.statusCode).toBe(409)
  expect(failed.json()).toMatchObject({
    error: {
      code: 'rewind_incomplete',
      details: {
        skipped: [{ agentId: 'reviewer', reason: 'no_answer' }],
        rewound: [{ agentId: 'builder', turnsUndone: 1 }],
      },
    },
  })
  expect(await visible(room.id)).toHaveLength(3)
  vi.mocked(fake().rewindSession).mockImplementation(real)
  fake().rewinds.length = 0
  // The unanswered command is still held against the room until it has expired.
  expect((await rewind(room.id, message.id)).statusCode).toBe(409)
  restoreRoomHolds(db.sqlite, Date.now() + 10 * 60_000)
  rewindingRooms.clear()
  const retried = await rewind(room.id, message.id)
  expect(retried.statusCode).toBe(200)
  // Builder was rewound before and has nothing left to undo.
  expect(fake().rewinds.map((item) => item.agentId)).toEqual(['reviewer'])
})
