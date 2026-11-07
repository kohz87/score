import type { Message } from '@score/contract'
import { expect, test } from 'vitest'
import { deleteRoom } from '../../src/domain/room-delete.ts'
import { deleteMessage } from '../../src/domain/rooms.ts'
import { MediaStore } from '../../src/media/store.ts'
import { png } from '../media-fixtures.ts'

import {
  DAY,
  createSharesHelpers,
  sharesTestSuite,
  type SharesTestState,
} from './shares-helpers.ts'

let db: SharesTestState['db']
let scheduler: SharesTestState['scheduler']
let app: SharesTestState['app']
let headers: SharesTestState['headers']
let state: SharesTestState
const current = (): SharesTestState => state
sharesTestSuite((next) => {
  state = next
  db = next.db
  scheduler = next.scheduler
  app = next.app
  headers = next.headers
}, current)

const { setPassword, room, say, create, tokenOf, page } = createSharesHelpers(current)

test('images are included only on request, by position, and only those of the share', async () => {
  await setPassword()
  const r = await room()
  const first = app.media!.store(png(80, 1), 'image/png')
  const other = app.media!.store(png(80, 2), 'image/png')
  await say(
    r.id,
    [
      { kind: 'text', text: 'look' },
      { kind: 'image', mediaId: first.mediaId },
    ],
    true,
  )
  const without = tokenOf((await create(r.id)).json().url)
  expect((await page(without)).body).not.toContain('<img')
  expect((await app.inject({ url: `/s/${without}/media/0` })).statusCode).toBe(404)
  const withImages = tokenOf((await create(r.id, { includeImages: true })).json().url)
  const html = (await page(withImages)).body
  expect(html).toContain(`<img src="/s/${withImages}/media/0"`)
  const image = await app.inject({ url: `/s/${withImages}/media/0` })
  expect(image.statusCode).toBe(200)
  expect(image.headers['content-type']).toBe('image/png')
  expect(image.headers['content-security-policy']).toBe(
    "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
  )
  expect(image.headers['cache-control']).toBe('no-store')
  expect(image.rawPayload.equals(png(80, 1))).toBe(true)
  // Another id (even a real one) or position is not reachable through the share.
  expect((await app.inject({ url: `/s/${withImages}/media/1` })).statusCode).toBe(404)
  expect((await app.inject({ url: `/s/${withImages}/media/${other.mediaId}` })).statusCode).toBe(
    404,
  )
  expect((await app.inject({ url: `/s/${withImages}/media/-1` })).statusCode).toBe(404)
  // The share does not list the id in its HTML, only positions.
  expect(html).not.toContain(first.mediaId)
})

// audit4-c #1 (S4-004): a share owns its images.
const refsOf = (id: string) =>
  (db.sqlite.prepare('SELECT refs FROM media WHERE id = ?').get(id) as { refs: number } | undefined)
    ?.refs
async function shareWithImage(r: { id: string }, mediaId: string, extra: Message['parts'] = []) {
  // A person's message holds one reference per distinct upload, as the send route does.
  const message = await say(r.id, [{ kind: 'image', mediaId }, ...extra], true)
  db.tx((sqlite) => app.media!.retain(sqlite, [mediaId], new Date(scheduler.now()).toISOString()))
  return message
}
const squeeze = () =>
  // A store on the same database with no room left: the sweep evicts everything unreferenced.
  new MediaStore(db, app.media!.dir, { quotaBytes: 1, clock: () => scheduler.now() }).sweep()

test('a shared image outlives its original message and eviction, until the share ends', async () => {
  await setPassword()
  const r = await room()
  const stored = app.media!.store(png(80, 1), 'image/png')
  const message = await shareWithImage(r, stored.mediaId)
  const token = tokenOf((await create(r.id, { includeImages: true })).json().url)
  expect(refsOf(stored.mediaId)).toBe(2)

  db.tx((sqlite) => {
    deleteMessage(sqlite, r.id, message.id, new Date(scheduler.now()).toISOString())
  })
  expect(refsOf(stored.mediaId)).toBe(1)
  squeeze()
  expect((await app.inject({ url: `/s/${token}/media/0` })).statusCode).toBe(200)

  const shares = (await app.inject({ url: `/api/rooms/${r.id}/shares`, headers })).json().items
  const revoked = await app.inject({
    method: 'DELETE',
    url: `/api/shares/${shares[0].id}`,
    headers,
  })
  expect(revoked.statusCode).toBe(204)
  expect(refsOf(stored.mediaId)).toBe(0)
  // Revoking twice releases nothing more.
  await app.inject({ method: 'DELETE', url: `/api/shares/${shares[0].id}`, headers })
  expect(refsOf(stored.mediaId)).toBe(0)
  squeeze()
  expect(refsOf(stored.mediaId)).toBeUndefined()
})

test('two shares of one image hold it separately; an image twice in one snapshot is held once', async () => {
  await setPassword()
  const r = await room()
  const stored = app.media!.store(png(80, 1), 'image/png')
  await shareWithImage(r, stored.mediaId, [{ kind: 'image', mediaId: stored.mediaId }])
  await say(r.id, [{ kind: 'image', mediaId: stored.mediaId }], true)
  expect(refsOf(stored.mediaId)).toBe(1) // the first message only
  const a = (await create(r.id, { includeImages: true })).json()
  expect(refsOf(stored.mediaId)).toBe(2) // one for the share, however often it names the image
  const b = (await create(r.id, { includeImages: true })).json()
  expect(refsOf(stored.mediaId)).toBe(3)
  await app.inject({ method: 'DELETE', url: `/api/shares/${a.id}`, headers })
  expect(refsOf(stored.mediaId)).toBe(2)
  squeeze()
  expect((await app.inject({ url: `/s/${tokenOf(b.url)}/media/0` })).statusCode).toBe(200)
})

test('an expired share lets go of its images in the next media sweep; deleting the room does too', async () => {
  await setPassword()
  const r = await room()
  const stored = app.media!.store(png(80, 1), 'image/png')
  await say(r.id, [{ kind: 'image', mediaId: stored.mediaId }], true)
  await create(r.id, { includeImages: true, expiresInDays: 1 })
  expect(refsOf(stored.mediaId)).toBe(1)
  squeeze()
  expect(refsOf(stored.mediaId)).toBe(1) // still live
  await scheduler.advance(2 * DAY)
  squeeze()
  expect(refsOf(stored.mediaId)).toBeUndefined() // released, then unreferenced and over quota

  const r2 = await room('second')
  const kept = app.media!.store(png(80, 2), 'image/png')
  await say(r2.id, [{ kind: 'image', mediaId: kept.mediaId }], true)
  await create(r2.id, { includeImages: true })
  expect(refsOf(kept.mediaId)).toBe(1)
  db.tx((sqlite) => deleteRoom(sqlite, r2.id, r2.name, new Date(scheduler.now()).toISOString()))
  expect(refsOf(kept.mediaId)).toBe(0)
})
