import { RoomVersionDetailSchema, RoomVersionsSchema } from '@score/contract'
import { expect, test } from 'vitest'
import {
  PostSchema,
  answer,
  ask,
  createRoom,
  events,
  fake,
  get,
  post,
  rewind,
  setupRewindTest,
  visible,
} from './rewind-helpers.ts'

setupRewindTest()

test('an edit rewinds first, then the correction links to the version; editing again continues the chain', async () => {
  const room = await createRoom()
  const original = await ask(room.id, 'one', ['builder'])
  await answer(room.id, original.id, 'builder')
  expect((await rewind(room.id, original.id, { mode: 'edit' })).statusCode).toBe(200)
  expect(await visible(room.id)).toEqual([])
  const corrected = await post(`/api/rooms/${room.id}/messages`, {
    text: 'two',
    to: ['builder'],
    edits: original.id,
  })
  expect(corrected.statusCode).toBe(200)
  const edit = PostSchema.parse(corrected.json()).message
  expect(edit.edits).toBe(original.id)
  expect(await visible(room.id)).toEqual([edit.id])
  expect(fake().rewinds).toHaveLength(1)
  const versions = RoomVersionsSchema.parse((await get(`/api/rooms/${room.id}/versions`)).json())
  expect(versions.items[0]).toMatchObject({
    anchorId: original.id,
    replacedBy: edit.id,
    number: 1,
    count: 2,
  })
  expect(events().filter((event) => event.type === 'message.updated')).toHaveLength(1)

  await answer(room.id, edit.id, 'builder')
  expect((await rewind(room.id, edit.id, { mode: 'edit' })).statusCode).toBe(200)
  const third = PostSchema.parse(
    (
      await post(`/api/rooms/${room.id}/messages`, {
        text: 'three',
        to: ['builder'],
        edits: edit.id,
      })
    ).json(),
  ).message
  const chain = RoomVersionsSchema.parse((await get(`/api/rooms/${room.id}/versions`)).json())
  expect(chain.items.map((item) => [item.anchorId, item.number, item.count])).toEqual([
    [edit.id, 2, 3],
    [original.id, 1, 3],
  ])
  expect(chain.items[0]!.replacedBy).toBe(third.id)
})

test('an edit without a rewind hides the original and what follows in Score only', async () => {
  const room = await createRoom()
  const original = await ask(room.id, 'one', ['builder'])
  const reply = await answer(room.id, original.id, 'builder')
  const edit = PostSchema.parse(
    (
      await post(`/api/rooms/${room.id}/messages`, {
        text: 'two',
        to: ['builder'],
        edits: original.id,
      })
    ).json(),
  ).message
  expect(await visible(room.id)).toEqual([edit.id])
  expect(fake().rewinds).toEqual([])
  const detail = RoomVersionDetailSchema.parse(
    (await get(`/api/rooms/${room.id}/versions/${original.id}`)).json(),
  )
  expect(detail.items.map((item) => item.id)).toEqual([original.id, reply])
  expect(detail.version.skipped).toEqual([{ agentId: 'builder', reason: 'score_only' }])
})
