import JSZip from 'jszip'
import { expect, test } from 'vitest'
import { ThemeDetailSchema } from '@score/contract'
import { PNG } from './helpers.ts'
import {
  PNG2,
  b64,
  call,
  detailOf,
  events,
  fullPackage,
  save,
  saveFiles,
  setupThemeRoutes,
  upload,
} from './routes-helpers.ts'

setupThemeRoutes()

// J1 (fourth-gate finding 2): file URLs are bound to the package revision, and the server enforces it.
test("J1: read A, replace with B at the same paths: A's file and licence URLs never return B's bytes", async () => {
  const created = await saveFiles(
    'mine',
    null,
    { assets: { 'img/a.png': b64(PNG) }, licenses: { LICENSE: 'licence A' } },
    '.a{background:url(asset:img/a.png)}',
  )
  expect(created.statusCode, created.body).toBe(200)
  const a = ThemeDetailSchema.parse(created.json())
  const replaced = await saveFiles(
    'mine',
    a.etag,
    { assets: { 'img/a.png': b64(PNG2) }, licenses: { LICENSE: 'licence B' } },
    '.a{background:url(asset:img/a.png)}',
  )
  expect(replaced.statusCode, replaced.body).toBe(200)
  const b = ThemeDetailSchema.parse(replaced.json())
  expect(b.etag).not.toBe(a.etag)
  expect(a.licenseFiles).toEqual(['LICENSE'])

  const stale = await call('GET', `/api/themes/mine/assets/img/a.png?rev=${a.etag}`)
  expect(stale.statusCode).toBe(409)
  expect((stale.json() as { error: { code: string } }).error.code).toBe('etag_mismatch')
  expect((stale.json() as { error: { details: { etag: string } } }).error.details.etag).toBe(b.etag)
  expect(stale.rawPayload.equals(PNG2)).toBe(false)
  const current = await call('GET', `/api/themes/mine/assets/img/a.png?rev=${b.etag}`)
  expect(current.statusCode).toBe(200)
  expect(current.rawPayload.equals(PNG2)).toBe(true)
  // An unversioned asset URL is not served at all.
  expect((await call('GET', '/api/themes/mine/assets/img/a.png')).statusCode).toBe(400)
  expect((await call('GET', '/api/themes/mine/assets/img/a.png?rev=nope')).statusCode).toBe(409)
  expect((await call('GET', '/api/themes/mine/assets/img/a.png?rev=a%20b')).statusCode).toBe(400)

  // Licence texts travel in the export: a stale revision is refused, the current one (or none) is served.
  expect((await call('GET', `/api/themes/mine/export?rev=${a.etag}`)).statusCode).toBe(409)
  const exported = await call('GET', `/api/themes/mine/export?rev=${b.etag}`)
  expect(exported.statusCode).toBe(200)
  expect(await (await JSZip.loadAsync(exported.rawPayload)).files['LICENSE']!.async('string')).toBe(
    'licence B',
  )
  expect((await call('GET', '/api/themes/mine/export')).statusCode).toBe(200)
})

test('J1: an identical re-import is a new revision, so the earlier URL is refused', async () => {
  const first = await upload(await fullPackage())
  const a = ThemeDetailSchema.parse((first.json() as { detail: object }).detail)
  const again = await upload(await fullPackage(), '?replace=1')
  expect(again.statusCode, again.body).toBe(201)
  expect((await call('GET', `/api/themes/seaside/assets/img/a.png?rev=${a.etag}`)).statusCode).toBe(
    409,
  )
})

test('J1: built-in themes serve their files at their fixed revision', async () => {
  const detail = await detailOf('harbour')
  const url = `/api/themes/harbour/assets/${detail.assets[0]}`
  expect((await call('GET', url)).statusCode).toBe(400)
  expect((await call('GET', `${url}?rev=${detail.etag}`)).statusCode).toBe(200)
  expect((await call('GET', `${url}?rev=${'0'.repeat(64)}`)).statusCode).toBe(409)
})

// X13 (cross-audit): saving or replacing the theme that is the shared look tells the other open devices.
test('X13: saving or replacing the theme in use emits look.changed; any other theme does not', async () => {
  const created = ThemeDetailSchema.parse(
    (await saveFiles('mine', null, { assets: { 'img/a.png': b64(PNG) } })).json(),
  )
  expect((await save('other', null)).statusCode).toBe(200)
  expect((await call('PUT', '/api/look', { activeTheme: 'mine', mode: 'dark' })).statusCode).toBe(
    204,
  )
  const looks = () => events.filter((event) => event.type === 'look.changed').map((e) => e.data)
  events.length = 0
  // Not the theme in use: nothing is announced.
  expect((await save('other', (await detailOf('other')).etag, '.a{color:red}')).statusCode).toBe(
    200,
  )
  expect(looks()).toEqual([])
  // A custom save of the theme in use.
  const saved = await save('mine', created.etag, '.a{color:red}')
  expect(saved.statusCode, saved.body).toBe(200)
  expect(looks()).toEqual([{ activeTheme: 'mine', mode: 'dark', resetGeneration: 0 }])
  // A replace by import (an imported theme in use).
  expect((await upload(await fullPackage())).statusCode).toBe(201)
  expect(
    (await call('PUT', '/api/look', { activeTheme: 'seaside', mode: 'dark' })).statusCode,
  ).toBe(204)
  events.length = 0
  expect((await upload(await fullPackage(), '?replace=1')).statusCode).toBe(201)
  expect(looks()).toEqual([{ activeTheme: 'seaside', mode: 'dark', resetGeneration: 0 }])
  // A failed save announces nothing.
  events.length = 0
  expect((await save('seaside', 'stale')).statusCode).toBeGreaterThanOrEqual(400)
  expect(looks()).toEqual([])
})

// Argon's note on X2: a newer version that dropped the file must answer a stale revision with the conflict, not a bare
// 404, so a copy from the stale draft stops with the plain "changed" message instead of "couldn't read the file".
test('X2: a file the newer version removed answers the old revision with 409, not 404', async () => {
  const a = ThemeDetailSchema.parse(
    (
      await saveFiles('mine', null, { assets: { 'img/a.png': b64(PNG), 'img/b.png': b64(PNG2) } })
    ).json(),
  )
  const b = ThemeDetailSchema.parse(
    (await saveFiles('mine', a.etag, { keep: ['img/a.png'] })).json(),
  )
  expect(b.assets).toEqual(['img/a.png'])
  const stale = await call('GET', `/api/themes/mine/assets/img/b.png?rev=${a.etag}`)
  expect(stale.statusCode).toBe(409)
  expect(stale.json()).toMatchObject({
    error: { code: 'etag_mismatch', details: { etag: b.etag } },
  })
  expect((await call('GET', `/api/themes/mine/assets/img/b.png?rev=${b.etag}`)).statusCode).toBe(
    404,
  )
})
