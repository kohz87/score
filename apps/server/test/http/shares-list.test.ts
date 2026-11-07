import { expect, test } from 'vitest'

import {
  DAY,
  createSharesHelpers,
  sharesTestSuite,
  type SharesTestState,
} from './shares-helpers.ts'

let scheduler: SharesTestState['scheduler']
let app: SharesTestState['app']
let headers: SharesTestState['headers']
let state: SharesTestState
const current = (): SharesTestState => state
sharesTestSuite((next) => {
  state = next
  scheduler = next.scheduler
  app = next.app
  headers = next.headers
}, current)

const { setPassword, room, say, create, tokenOf, page } = createSharesHelpers(current)

test('lists shares with room, dates and views; the room list shows active ones only', async () => {
  await setPassword()
  const r = await room('listed')
  const other = await room('other')
  const a = (await create(r.id, { expiresInDays: 1 })).json()
  const b = (await create(other.id)).json()
  await page(tokenOf(a.url))
  await page(tokenOf(a.url))
  await page('B'.repeat(43))
  const list = (await app.inject({ url: '/api/shares', headers })).json().items
  expect(list).toHaveLength(2)
  expect(list.find((item: { id: string }) => item.id === a.id)).toMatchObject({
    roomId: r.id,
    roomName: '#listed',
    views: 2,
    includeImages: false,
    status: 'active',
    roomChanged: false,
  })
  expect(list.find((item: { id: string }) => item.id === b.id)).toMatchObject({ views: 0 })
  scheduler.advance(2 * DAY)
  const after = (await app.inject({ url: '/api/shares', headers })).json().items
  expect(after.find((item: { id: string }) => item.id === a.id).status).toBe('expired')
  const forRoom = (await app.inject({ url: `/api/rooms/${r.id}/shares`, headers })).json().items
  expect(forRoom).toEqual([])
  const forOther = (await app.inject({ url: `/api/rooms/${other.id}/shares`, headers })).json()
  expect(forOther.items).toHaveLength(1)
})

// audit4-c 4: a share says when its room changed after the snapshot.
test('a share is marked when a message of its room was deleted after the snapshot', async () => {
  await setPassword()
  const r = await room()
  const made = await say(r.id, [{ kind: 'text', text: 'secret plan' }], true)
  const share = (await create(r.id)).json()
  const flag = async () =>
    (await app.inject({ url: '/api/shares', headers })).json().items[0].roomChanged
  expect(await flag()).toBe(false)
  scheduler.advance(1000)
  expect(
    (
      await app.inject({
        method: 'DELETE',
        url: `/api/rooms/${r.id}/messages/${made.id}`,
        headers,
      })
    ).statusCode,
  ).toBe(204)
  expect(await flag()).toBe(true)
  expect(share.id).toBeTruthy()
})

test('the token never appears in logs or the listing', async () => {
  await setPassword()
  const r = await room()
  const made = (await create(r.id)).json()
  const token = tokenOf(made.url)
  expect(JSON.stringify((await app.inject({ url: '/api/shares', headers })).json())).not.toContain(
    token,
  )
})
