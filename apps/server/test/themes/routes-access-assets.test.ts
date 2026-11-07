import JSZip from 'jszip'
import { renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { ThemeDetailSchema, ThemeListSchema } from '@score/contract'
import { AVIF, JPEG, PNG, WEBP, WOFF2, manifestJson, zipOf, type Entry } from './helpers.ts'
import {
  call,
  dir,
  events,
  fileUrl,
  fullPackage,
  headers,
  setupThemeRoutes,
  upload,
} from './routes-helpers.ts'

setupThemeRoutes()

test('every route needs a paired browser, and changes need the web-client header', async () => {
  for (const [method, url] of [
    ['GET', '/api/themes'],
    ['GET', '/api/themes/score'],
    ['GET', '/api/themes/score/assets/img/a.png'],
    ['GET', '/api/themes/score/export'],
    ['PUT', '/api/themes/x'],
    ['DELETE', '/api/themes/x'],
    ['PUT', '/api/look'],
  ] as const) {
    const res = await call(method, url, method === 'PUT' ? {} : undefined, {
      'x-score-client': 'web',
    })
    expect(res.statusCode, `${method} ${url}`).toBe(401)
  }
  expect((await upload(await fullPackage(), '', { 'x-score-client': 'web' })).statusCode).toBe(401)
  const noHeader = await call(
    'PUT',
    '/api/look',
    { activeTheme: 'paper', mode: 'dark' },
    {
      cookie: headers.cookie,
    },
  )
  expect(noHeader.statusCode).toBeGreaterThanOrEqual(400)
  expect(events.filter((event) => event.type === 'look.changed')).toEqual([])
})

test('GET /api/themes lists the built-ins, imports, the active theme and the mode', async () => {
  const list = ThemeListSchema.parse((await call('GET', '/api/themes')).json())
  expect(list.items.map((item) => item.id)).toEqual([
    'score',
    'paper',
    'night',
    'dense',
    'harbour',
    'ledger',
    'studio',
  ])
  expect(list).toMatchObject({ active: 'score', mode: 'system' })
  await upload(await fullPackage())
  const after = ThemeListSchema.parse((await call('GET', '/api/themes')).json())
  expect(after.items.map((item) => [item.id, item.source, item.hasCss])).toContainEqual([
    'seaside',
    'imported',
    true,
  ])
})

test('GET /api/themes/:id: detail, built-in detail and 404', async () => {
  await upload(await fullPackage())
  const detail = ThemeDetailSchema.parse((await call('GET', '/api/themes/seaside')).json())
  expect(detail.assets).toEqual(['fonts/f.woff2', 'img/a.png'])
  expect(detail.css).toBe('.a{background:url(asset:img/a.png)}')
  expect(
    ThemeDetailSchema.parse((await call('GET', '/api/themes/night')).json()).summary,
  ).toMatchObject({
    source: 'builtin',
  })
  const missing = await call('GET', '/api/themes/nope')
  expect(missing.statusCode).toBe(404)
  expect(missing.json()).toMatchObject({ error: { code: 'not_found' } })
  expect((await call('GET', '/api/themes/..%2Fx')).statusCode).toBeGreaterThanOrEqual(400)
})

test('assets are served with their exact type, nosniff, inline and private', async () => {
  const bytes = {
    'assets/img/a.png': [PNG, 'image/png'],
    'assets/img/b.jpg': [JPEG, 'image/jpeg'],
    'assets/img/c.webp': [WEBP, 'image/webp'],
    'assets/img/d.avif': [AVIF, 'image/avif'],
    'assets/fonts/e.woff2': [WOFF2, 'font/woff2'],
  } as const
  const entries: Record<string, Entry> = { 'theme.json': manifestJson() }
  for (const [name, [data]] of Object.entries(bytes)) entries[name] = data
  expect((await upload(await zipOf(entries))).statusCode).toBe(201)
  for (const [name, [data, type]] of Object.entries(bytes)) {
    const res = await call('GET', await fileUrl('seaside', name))
    expect(res.statusCode, name).toBe(200)
    expect(res.headers['content-type']).toBe(type)
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['content-disposition']).toBe('inline')
    expect(res.headers['cache-control']).toContain('private')
    expect(res.rawPayload.equals(data)).toBe(true)
  }
})

test('assets: unknown files, odd paths and a symlink planted on disk are 404', async () => {
  await upload(await fullPackage())
  for (const url of [
    '/api/themes/seaside/assets/img/missing.png',
    '/api/themes/seaside/assets/img/a.svg',
    '/api/themes/seaside/assets/other/a.png',
    '/api/themes/seaside/assets/img/../../../../etc/hostname',
    '/api/themes/seaside/assets/img/%2e%2e/a.png',
    '/api/themes/seaside/assets/img%2f..%2f..%2fx.png',
    '/api/themes/seaside/assets/',
    '/api/themes/nope/assets/img/a.png',
  ]) {
    const res = await call('GET', `${url}?rev=${'a'.repeat(64)}`)
    expect(res.statusCode, url).toBeGreaterThanOrEqual(400)
    expect(res.statusCode, url).toBeLessThan(500)
  }
  const target = join(dir, 'secret.png')
  writeFileSync(target, PNG)
  const link = join(dir, 'themes/seaside/assets/img/link.png')
  symlinkSync(target, link)
  expect((await call('GET', await fileUrl('seaside', 'assets/img/link.png'))).statusCode).toBe(404)
  unlinkSync(link)
})

test('assets: a symlinked asset folder is neither listed, served nor exported (K2 X4)', async () => {
  await upload(await fullPackage())
  const outside = join(dir, 'outside')
  renameSync(join(dir, 'themes/seaside/assets/img'), outside)
  symlinkSync(outside, join(dir, 'themes/seaside/assets/img'))
  const detail = ThemeDetailSchema.parse((await call('GET', '/api/themes/seaside')).json())
  // With the current revision (J1), so only the symlink rule can refuse it.
  expect(
    (await call('GET', `/api/themes/seaside/assets/img/a.png?rev=${detail.etag}`)).statusCode,
  ).toBe(404)
  expect(detail.assets.filter((path) => path.startsWith('img/'))).toEqual([])
  const exported = await call('GET', '/api/themes/seaside/export')
  expect(exported.statusCode).toBe(200)
  const zip = await JSZip.loadAsync(exported.rawPayload)
  expect(Object.keys(zip.files).filter((name) => name.startsWith('assets/img/'))).toEqual([])
})
