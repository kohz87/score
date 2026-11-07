import { expect, test, vi } from 'vitest'
import { rewindingRooms, restoreRoomHolds } from '../../src/domain/room-rewinding.ts'
import {
  answer,
  ask,
  createRoom,
  db,
  fake,
  get,
  port,
  post,
  rewind,
  setupRewindTest,
} from './rewind-helpers.ts'

setupRewindTest()

test("a rewind is refused while an agent is answering or work is queued, and for other people's messages", async () => {
  const room = await createRoom()
  const message = await ask(room.id, 'go', ['builder'])
  const queued = await rewind(room.id, message.id)
  expect(queued.statusCode).toBe(409)
  expect(
    (await get(`/api/rooms/${room.id}/messages/${message.id}/rewind-plan`)).json(),
  ).toMatchObject({ blocked: expect.stringContaining('answering') })
  const reply = await answer(room.id, message.id, 'builder')
  expect((await rewind(room.id, reply)).statusCode).toBe(400)
  expect((await rewind(room.id, 'nope')).statusCode).toBe(404)
  expect((await rewind(room.id, message.id, { mode: 'x' })).statusCode).toBe(400)
  db.sqlite.exec('UPDATE team_state SET paused_at = datetime()')
  db.sqlite.exec("UPDATE message_runs SET state = 'pending'")
  expect(
    (await get(`/api/rooms/${room.id}/messages/${message.id}/rewind-plan`)).json(),
  ).toMatchObject({ blocked: expect.stringContaining('paused') })
})

// audit4-c 2: nothing new starts in a room whose sessions are being rewound.
test('a message or retry posted while the room is being rewound is refused', async () => {
  const room = await createRoom()
  const first = await ask(room.id, 'first', ['builder'])
  const reply = await answer(room.id, first.id, 'builder')
  let release!: () => void
  vi.spyOn(fake(), 'rewindSession').mockImplementation(async (req) => {
    if (req.dryRun) return { status: 'ready' }
    await new Promise<void>((resolve) => (release = resolve))
    return { status: 'rewound', turnsUndone: 1, rewoundCount: 2 }
  })
  const running = rewind(room.id, first.id)
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  const posted = await post(`/api/rooms/${room.id}/messages`, { text: 'too soon', to: ['builder'] })
  expect(posted.statusCode).toBe(409)
  const retried = await post(`/api/rooms/${room.id}/messages/${reply}/retry`, {})
  expect(retried.statusCode).toBe(409)
  release()
  expect((await running).statusCode).toBe(200)
  // Once it is done the room takes messages again.
  expect(
    (await post(`/api/rooms/${room.id}/messages`, { text: 'later', to: ['builder'] })).statusCode,
  ).toBe(200)
})

test('an unanswered rewind command keeps the room held until it has expired, also after a restart', async () => {
  const room = await createRoom()
  const message = await ask(room.id, 'go', ['builder'])
  await answer(room.id, message.id, 'builder')
  vi.spyOn(fake(), 'rewindSession').mockImplementation(async (req) =>
    req.dryRun ? { status: 'ready' } : { status: 'skipped', reason: 'no_answer' },
  )
  const failed = await rewind(room.id, message.id)
  expect(failed.statusCode).toBe(409)
  // The plugin may still claim the command: the room can't take new work meanwhile.
  expect(rewindingRooms.has(room.id)).toBe(true)
  const held = await post(`/api/rooms/${room.id}/messages`, { text: 'again', to: ['builder'] })
  expect(held.statusCode).toBe(409)
  // Persisted: a restart restores the hold, and expired rows are dropped.
  rewindingRooms.clear()
  restoreRoomHolds(db.sqlite, Date.now())
  expect(rewindingRooms.has(room.id)).toBe(true)
  rewindingRooms.clear()
  restoreRoomHolds(db.sqlite, Date.now() + 10 * 60_000)
  expect(rewindingRooms.has(room.id)).toBe(false)
  expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM rewind_holds').get()).toEqual({ n: 0 })
})

test('a message request that was already preparing when a rewind started does not queue a turn (audit5-e)', async () => {
  const room = await createRoom()
  const first = await ask(room.id, 'first', ['builder'])
  await answer(room.id, first.id, 'builder')
  let openGate!: () => void
  const gate = new Promise<void>((resolve) => (openGate = resolve))
  const real = port.listAgents.bind(port)
  vi.spyOn(port, 'listAgents').mockImplementationOnce(async () => {
    await gate
    return real()
  })
  const sending = post(`/api/rooms/${room.id}/messages`, { text: 'slow', to: ['builder'] })
  await vi.waitFor(() => expect(port.listAgents).toHaveBeenCalled())
  let release!: () => void
  vi.spyOn(fake(), 'rewindSession').mockImplementation(async (req) => {
    if (req.dryRun) return { status: 'ready' }
    await new Promise<void>((resolve) => (release = resolve))
    return { status: 'rewound', turnsUndone: 1, rewoundCount: 2 }
  })
  const rewinding = rewind(room.id, first.id)
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  openGate()
  expect((await sending).statusCode).toBe(409)
  release()
  expect((await rewinding).statusCode).toBe(200)
})
