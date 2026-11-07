import JSZip from 'jszip'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { ThemeDetailSchema, ThemeImportResultSchema, ThemeListSchema } from '@score/contract'
import { checkThemeCss } from '../../src/themes/css-check.ts'
import { resetLook } from '../../src/themes/look.ts'
import { manifestAssets, readThemePackage } from '../../src/themes/package.ts'
import { zipOf } from './helpers.ts'
import {
  call,
  db,
  dir,
  events,
  fileUrl,
  fullPackage,
  ingest,
  save,
  setupThemeRoutes,
  upload,
} from './routes-helpers.ts'

setupThemeRoutes()

test('export is a zip in the import layout and round-trips through import', async () => {
  await upload(await fullPackage())
  const res = await call('GET', '/api/themes/seaside/export')
  expect(res.statusCode).toBe(200)
  expect(res.headers['content-type']).toBe('application/zip')
  expect(res.headers['content-disposition']).toBe('attachment; filename="seaside.zip"')
  expect(res.headers['x-content-type-options']).toBe('nosniff')
  const zip = await JSZip.loadAsync(res.rawPayload)
  expect(Object.keys(zip.files)).toEqual([
    'theme.json',
    'style.css',
    'assets/fonts/f.woff2',
    'assets/img/a.png',
  ])
  expect((await call('DELETE', '/api/themes/seaside')).statusCode).toBe(204)
  expect((await upload(res.rawPayload)).statusCode).toBe(201)
  const again = await call('GET', '/api/themes/seaside/export')
  expect(again.rawPayload.equals(res.rawPayload)).toBe(true)
  const detail = ThemeDetailSchema.parse((await call('GET', '/api/themes/seaside')).json())
  expect(detail.assets).toEqual(['fonts/f.woff2', 'img/a.png'])
  expect(detail.css).toBe('.a{background:url(asset:img/a.png)}')
  expect((await call('GET', '/api/themes/nope/export')).statusCode).toBe(404)
  const builtin = await JSZip.loadAsync((await call('GET', '/api/themes/paper/export')).rawPayload)
  expect(Object.keys(builtin.files)).toEqual(['theme.json', 'style.css'])
  const manifest = JSON.parse(await builtin.files['theme.json']!.async('string'))
  expect(manifest).toMatchObject({ id: 'paper', fonts: { heading: 'Source Serif 4' } })
})

test('DELETE: 204 and the folder goes; built-ins and the active theme are 409; unknown is 404', async () => {
  await upload(await fullPackage())
  expect((await call('DELETE', '/api/themes/score')).json()).toMatchObject({
    error: { code: 'builtin_theme' },
  })
  expect((await call('DELETE', '/api/themes/nope')).statusCode).toBe(404)
  expect(
    (await call('PUT', '/api/look', { activeTheme: 'seaside', mode: 'dark' })).statusCode,
  ).toBe(204)
  const active = await call('DELETE', '/api/themes/seaside')
  expect(active.statusCode).toBe(409)
  expect(active.json()).toMatchObject({ error: { code: 'theme_active' } })
  await call('PUT', '/api/look', { activeTheme: 'score', mode: 'dark' })
  expect((await call('DELETE', '/api/themes/seaside')).statusCode).toBe(204)
  expect(() => statSync(join(dir, 'themes/seaside'))).toThrow()
  expect((await call('GET', '/api/themes/seaside')).statusCode).toBe(404)
})

test('PUT /api/look: 204, persisted, list reflects it, and look.changed is emitted', async () => {
  const res = await call('PUT', '/api/look', { activeTheme: 'night', mode: 'dark' })
  expect(res.statusCode).toBe(204)
  expect(res.body).toBe('')
  expect(ThemeListSchema.parse((await call('GET', '/api/themes')).json())).toMatchObject({
    active: 'night',
    mode: 'dark',
  })
  await ingest.flushListeners()
  expect(events.filter((event) => event.type === 'look.changed').map((e) => e.data)).toEqual([
    { activeTheme: 'night', mode: 'dark', resetGeneration: 0 },
  ])
})

test('a host reset bumps resetGeneration: GET /api/themes shows it and look.changed carries it', async () => {
  expect(ThemeListSchema.parse((await call('GET', '/api/themes')).json()).resetGeneration).toBe(0)
  await call('PUT', '/api/look', { activeTheme: 'night', mode: 'dark' })
  // `scripts/score look reset` runs this function (Score may be stopped, so there is no event for it).
  db.tx((sqlite) => resetLook(sqlite))
  expect(ThemeListSchema.parse((await call('GET', '/api/themes')).json())).toMatchObject({
    active: 'score',
    mode: 'system',
    resetGeneration: 1,
  })
  await call('PUT', '/api/look', { activeTheme: 'paper', mode: 'light' })
  await ingest.flushListeners()
  expect(events.filter((event) => event.type === 'look.changed').map((e) => e.data)).toEqual([
    { activeTheme: 'night', mode: 'dark', resetGeneration: 0 },
    { activeTheme: 'paper', mode: 'light', resetGeneration: 1 },
  ])
})

test('PUT /api/look: unknown theme is 404, bad bodies are 400, and nothing changes or is emitted', async () => {
  expect((await call('PUT', '/api/look', { activeTheme: 'nope', mode: 'dark' })).statusCode).toBe(
    404,
  )
  for (const body of [
    { activeTheme: 'score' },
    { activeTheme: '../x', mode: 'dark' },
    { activeTheme: 'score', mode: 'purple' },
    { activeTheme: 'score', mode: 'dark', extra: 1 },
  ])
    expect((await call('PUT', '/api/look', body)).statusCode).toBe(400)
  expect(ThemeListSchema.parse((await call('GET', '/api/themes')).json())).toMatchObject({
    active: 'score',
    mode: 'system',
  })
  await ingest.flushListeners()
  expect(events.filter((event) => event.type === 'look.changed')).toEqual([])
})

test.each(['harbour', 'ledger', 'studio'])(
  'built-in %s is a real package: detail, assets, export, and a copy imports under a new id',
  async (id) => {
    const detail = ThemeDetailSchema.parse((await call('GET', `/api/themes/${id}`)).json())
    expect(detail.summary).toMatchObject({ id, source: 'builtin', author: 'Score', hasCss: true })
    expect(detail.manifest.description).toBeTruthy()
    // The CSS passes the checks an import would make, and every file the manifest or the CSS names is shipped.
    expect(checkThemeCss(detail.css).reasons).toEqual([])
    const named = [...manifestAssets(detail.manifest), ...checkThemeCss(detail.css).assets]
    for (const path of named) expect(detail.assets, path).toContain(path)
    expect(detail.assets.length).toBeGreaterThan(0)
    for (const path of detail.assets) {
      const file = await call('GET', await fileUrl(id, `assets/${path}`))
      expect(file.statusCode, path).toBe(200)
      expect(file.headers['x-content-type-options']).toBe('nosniff')
      expect(file.headers['content-type']).toBe(
        path.endsWith('.woff2') ? 'font/woff2' : 'image/png',
      )
      expect(file.rawPayload.length).toBeGreaterThan(1000)
    }
    // Built-ins can't be changed or removed, nor taken by an import.
    expect((await save(id, detail.etag)).json()).toMatchObject({ error: { code: 'builtin_theme' } })
    expect((await call('DELETE', `/api/themes/${id}`)).json()).toMatchObject({
      error: { code: 'builtin_theme' },
    })
    expect((await upload(await fullPackage(id))).statusCode).toBe(422)
    // Export, rename and import: the way to start a theme from a built-in one.
    const exported = await call('GET', `/api/themes/${id}/export`)
    const zip = await JSZip.loadAsync(exported.rawPayload)
    expect(
      Object.keys(zip.files)
        .filter((name) => !name.endsWith('/'))
        .sort(),
    ).toEqual(
      [
        'theme.json',
        'style.css',
        ...(id === 'harbour' ? [] : ['OFL.txt']),
        ...detail.assets.map((path) => `assets/${path}`),
      ].sort(),
    )
    // The fonts' licence text travels with them.
    const licence = zip.file('OFL.txt')
    if (id === 'harbour') expect(licence).toBeNull()
    else expect(await licence!.async('string')).toContain('SIL OPEN FONT LICENSE Version 1.1')
    const manifest = JSON.parse(await zip.file('theme.json')!.async('string')) as { id: string }
    manifest.id = `${id}-copy`
    zip.file('theme.json', JSON.stringify(manifest))
    const copy = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
    expect((await readThemePackage(copy)).manifest.id).toBe(`${id}-copy`)
    const imported = await upload(copy)
    expect(imported.statusCode).toBe(201)
    expect(ThemeImportResultSchema.parse(imported.json()).theme).toMatchObject({
      id: `${id}-copy`,
      source: 'imported',
    })
    // The copy keeps the licence file: exporting it again still has it, byte for byte.
    const again = await JSZip.loadAsync(
      (await call('GET', `/api/themes/${id}-copy/export`)).rawPayload,
    )
    if (id === 'harbour') expect(again.file('OFL.txt')).toBeNull()
    else expect(await again.file('OFL.txt')!.async('string')).toBe(await licence!.async('string'))
  },
)

test('the example theme of docs/themes/example-theme zips up and imports through the real route', async () => {
  const folder = fileURLToPath(new URL('../../../../docs/themes/example-theme/', import.meta.url))
  const entries: Record<string, Buffer> = {}
  const walk = (path: string) => {
    for (const name of readdirSync(join(folder, path))) {
      const relative = path ? `${path}/${name}` : name
      if (statSync(join(folder, relative)).isDirectory()) walk(relative)
      else entries[relative] = readFileSync(join(folder, relative))
    }
  }
  walk('')
  expect(Object.keys(entries).sort()).toEqual(['assets/img/sand.png', 'style.css', 'theme.json'])
  const res = await upload(await zipOf(entries))
  expect(res.statusCode, res.body).toBe(201)
  const result = ThemeImportResultSchema.parse(res.json())
  expect(result.theme).toMatchObject({ id: 'sandbar', name: 'Sandbar', source: 'imported' })
  const detail = ThemeDetailSchema.parse((await call('GET', '/api/themes/sandbar')).json())
  expect(detail.assets).toEqual(['img/sand.png'])
  expect(detail.manifest.background?.image).toBe('asset:img/sand.png')
  expect(detail.css).toContain('font-weight')
  const picture = await call('GET', await fileUrl('sandbar', 'assets/img/sand.png'))
  expect(picture.statusCode).toBe(200)
  expect(picture.headers['content-type']).toBe('image/png')
})
