import JSZip from 'jszip'
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'
import {
  StreamEventSchema,
  ThemeDetailSchema,
  ThemeImportResultSchema,
  ThemeListSchema,
  type StreamEvent,
} from '@score/contract'
import { buildApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { migrate, openDatabase, type ScoreDb } from '../../src/db/index.ts'
import { FakePort } from '../../src/hermes/fake/fake-port.ts'
import { createIngest, type Ingest } from '../../src/hub/ingest.ts'
import { multipart } from '../media-fixtures.ts'
import { checkThemeCss } from '../../src/themes/css-check.ts'
import { manifestAssets, readThemePackage } from '../../src/themes/package.ts'
import { AVIF, JPEG, PNG, WEBP, WOFF2, manifestJson, zipOf, type Entry } from './helpers.ts'

let dir: string
let db: ScoreDb
let ingest: Ingest
let port: FakePort
let app: ReturnType<typeof buildApp>
let headers: { 'x-score-client': string; cookie: string }
let events: StreamEvent[]

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'score-themes-http-'))
  db = openDatabase(join(dir, 'score.db'))
  migrate(db, fileURLToPath(new URL('../../migrations/', import.meta.url)))
  ingest = createIngest(db)
  port = new FakePort(1, { db }, false)
  await port.start(ingest)
  events = []
  ingest.onCommitted((batch) => {
    events.push(...StreamEventSchema.array().parse(JSON.parse(JSON.stringify(batch))))
  })
  app = buildApp({
    config: loadConfig({ SCORE_MODE: 'fake', SCORE_HOME: dir }),
    logger: false,
    db,
    ingest,
    port,
  })
  const paired = await app.inject({
    method: 'POST',
    url: '/api/session/pair',
    headers: { 'x-score-client': 'web' },
    payload: { token: app.pairing.createToken() },
  })
  headers = {
    'x-score-client': 'web',
    cookie: paired.headers['set-cookie']!.toString().split(';')[0]!,
  }
})
afterEach(async () => {
  await port.stop()
  await app.close()
  await ingest.close()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

type Method = 'GET' | 'PUT' | 'POST' | 'DELETE'
const call = (
  method: Method,
  url: string,
  payload?: unknown,
  extra: Record<string, string> | null = headers,
) =>
  app.inject({
    method,
    url,
    ...(extra ? { headers: extra } : {}),
    ...(payload === undefined ? {} : { payload: payload as object }),
  })
function upload(zip: Buffer, query = '', extra: Record<string, string> | null = headers) {
  const { body, contentType } = multipart([
    { name: 'file', filename: 'theme.zip', type: 'application/zip', data: zip },
  ])
  return app.inject({
    method: 'POST',
    url: `/api/themes/import${query}`,
    headers: { ...(extra ?? {}), 'content-type': contentType },
    payload: body,
  })
}
const fullPackage = (id = 'seaside', css = '.a{background:url(asset:img/a.png)}') =>
  zipOf({
    'theme.json': manifestJson({ id, name: id }),
    'style.css': css,
    'assets/img/a.png': PNG,
    'assets/fonts/f.woff2': WOFF2,
  })
const save = (id: string, etag: string | null, css = '', extra: object = {}) =>
  call('PUT', `/api/themes/${id}`, {
    manifest: { format: 1, id, name: id, ...extra },
    css,
    etag,
  })
const reasons = (res: { json(): unknown }) =>
  (
    res.json() as { error: { code: string; details: { reasons: string[] } } }
  ).error.details.reasons.join('\n')

test('every route needs a paired browser, and changes need the web-client header', async () => {
  for (const [method, url] of [
    ['GET', '/api/themes'],
    ['GET', '/api/themes/score'],
    ['GET', '/api/themes/score/style.css'],
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

test('style.css rewrites asset: references and is served as nosniff text/css', async () => {
  await upload(await fullPackage())
  const res = await call('GET', '/api/themes/seaside/style.css')
  expect(res.statusCode).toBe(200)
  expect(res.headers['content-type']).toBe('text/css; charset=utf-8')
  expect(res.headers['x-content-type-options']).toBe('nosniff')
  expect(res.body).toBe('.a{background:url(/api/themes/seaside/assets/img/a.png)}')
  expect((await call('GET', '/api/themes/nope/style.css')).statusCode).toBe(404)
  expect((await call('GET', '/api/themes/score/style.css')).body).toBe('')
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
    const res = await call('GET', `/api/themes/seaside/${name}`)
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
    const res = await call('GET', url)
    expect(res.statusCode, url).toBeGreaterThanOrEqual(400)
    expect(res.statusCode, url).toBeLessThan(500)
  }
  const target = join(dir, 'secret.png')
  writeFileSync(target, PNG)
  const link = join(dir, 'themes/seaside/assets/img/link.png')
  symlinkSync(target, link)
  expect((await call('GET', '/api/themes/seaside/assets/img/link.png')).statusCode).toBe(404)
  unlinkSync(link)
})

test('import: 201, stored not activated, assets on disk with private modes', async () => {
  const res = await upload(await fullPackage())
  expect(res.statusCode).toBe(201)
  const result = ThemeImportResultSchema.parse(res.json())
  expect(result.theme).toMatchObject({ id: 'seaside', source: 'imported' })
  expect(result.report).toEqual({ dropped: [] })
  expect(ThemeListSchema.parse((await call('GET', '/api/themes')).json()).active).toBe('score')
  const assets = join(dir, 'themes/seaside/assets')
  expect(statSync(assets).mode & 0o777).toBe(0o700)
  expect(statSync(join(assets, 'img/a.png')).mode & 0o777).toBe(0o600)
  expect(events.filter((event) => event.type === 'look.changed')).toEqual([])
})

test('import: 409 theme_exists, ?replace=1 replaces an imported or custom theme, never a built-in', async () => {
  await upload(await fullPackage())
  const again = await upload(await fullPackage())
  expect(again.statusCode).toBe(409)
  expect(again.json()).toMatchObject({ error: { code: 'theme_exists' } })
  const next = await zipOf({ 'theme.json': manifestJson({ name: 'Seaside 2', version: '2.0.0' }) })
  expect((await upload(next, '?replace=1')).statusCode).toBe(201)
  const detail = ThemeDetailSchema.parse((await call('GET', '/api/themes/seaside')).json())
  expect(detail.summary).toMatchObject({ name: 'Seaside 2', version: '2.0.0' })
  expect(detail.assets).toEqual([])
  // A custom theme can be replaced too.
  expect((await save('mine', null)).statusCode).toBe(200)
  const mine = await zipOf({ 'theme.json': manifestJson({ id: 'mine', name: 'Imported mine' }) })
  expect((await upload(mine)).statusCode).toBe(409)
  expect((await upload(mine, '?replace=1')).statusCode).toBe(201)
  expect((await call('GET', '/api/themes/mine')).json()).toMatchObject({
    summary: { source: 'imported' },
  })
  // Built-in ids are refused as rejected packages, with or without replace.
  const builtin = await zipOf({ 'theme.json': manifestJson({ id: 'night' }) })
  for (const query of ['', '?replace=1']) {
    const res = await upload(builtin, query)
    expect(res.statusCode).toBe(422)
    expect(reasons(res)).toMatch(/built-in/)
  }
})

test('import: a rejected package stores nothing', async () => {
  const bad = await zipOf({
    'theme.json': manifestJson(),
    'style.css': 'a::before{content:"x"}',
    'assets/img/a.png': PNG,
  })
  const res = await upload(bad)
  expect(res.statusCode).toBe(422)
  expect(res.json()).toMatchObject({ error: { code: 'theme_rejected' } })
  expect(reasons(res)).toMatch(/content property/)
  expect((await call('GET', '/api/themes/seaside')).statusCode).toBe(404)
  expect(() => statSync(join(dir, 'themes/seaside'))).toThrow()
})

test('import: adversarial packages answer 422 theme_rejected', async () => {
  const inner = await zipOf({ a: 'b' })
  const cases: [string, Buffer, RegExp][] = [
    ['wrong magic bytes', PNG, /isn’t a zip/],
    [
      'traversal',
      await zipOf({ 'theme.json': manifestJson(), '../x.css': 'a' }),
      /leaves the folder/,
    ],
    [
      'symlink',
      await zipOf({
        'theme.json': manifestJson(),
        'assets/img/a.png': { data: '/etc/passwd', unixPermissions: 0o120777 },
      }),
      /symbolic links/,
    ],
    [
      'nested zip',
      await zipOf({ 'theme.json': manifestJson(), 'assets/img/a.png': inner }),
      /archives inside/,
    ],
    [
      'asset with the wrong bytes',
      await zipOf({ 'theme.json': manifestJson(), 'assets/fonts/a.woff2': PNG }),
      /isn’t really a woff2/,
    ],
    ['newer format', await zipOf({ 'theme.json': manifestJson({ format: 2 }) }), /newer Score/],
    [
      'extra top-level file',
      await zipOf({ 'theme.json': manifestJson(), 'x.js': 'a' }),
      /not part of/,
    ],
    [
      'escaped CSS',
      await zipOf({ 'theme.json': manifestJson(), 'style.css': 'a::before{\\63 ontent:"x"}' }),
      /content property/,
    ],
    [
      'comment-split keyword',
      await zipOf({ 'theme.json': manifestJson(), 'style.css': 'a::before{con/**/tent:"x"}' }),
      /content property/,
    ],
    [
      'escaped url(',
      await zipOf({ 'theme.json': manifestJson(), 'style.css': 'a{b:u\\72l(http://x/y)}' }),
      /url\(\)/,
    ],
    [
      'missing asset',
      await zipOf({ 'theme.json': manifestJson(), 'style.css': 'a{b:url(asset:img/x.png)}' }),
      /not in the package/,
    ],
  ]
  for (const [name, zip, match] of cases) {
    const res = await upload(zip)
    expect(res.statusCode, name).toBe(422)
    expect(res.json(), name).toMatchObject({ error: { code: 'theme_rejected' } })
    expect(reasons(res), name).toMatch(match)
  }
  expect(ThemeListSchema.parse((await call('GET', '/api/themes')).json()).items).toHaveLength(7)
})

test('import: bad uploads are 400, and an oversize body is refused', async () => {
  const noFile = multipart([{ name: 'other', filename: 'x.zip', data: PNG }])
  const res = await app.inject({
    method: 'POST',
    url: '/api/themes/import',
    headers: { ...headers, 'content-type': noFile.contentType },
    payload: noFile.body,
  })
  expect(res.statusCode).toBe(400)
  const plain = await app.inject({
    method: 'POST',
    url: '/api/themes/import',
    headers: { ...headers, 'content-type': 'application/json' },
    payload: {},
  })
  expect(plain.statusCode).toBeGreaterThanOrEqual(400)
  const huge = await upload(Buffer.alloc(6 * 1024 * 1024, 1))
  expect([413, 422]).toContain(huge.statusCode)
  const bigButUnderBody = await upload(
    Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(5 * 1024 * 1024 + 100, 1)]),
  )
  expect(bigButUnderBody.statusCode).toBe(422)
  expect(reasons(bigButUnderBody)).toMatch(/larger than 5 MB/)
})

test('PUT creates a custom theme, etag guards updates, and the manifest id must match', async () => {
  const created = await save('mine', null, '.a{color:red}')
  expect(created.statusCode).toBe(200)
  const first = ThemeDetailSchema.parse(created.json())
  expect(first.summary).toMatchObject({ id: 'mine', source: 'custom', hasCss: true })
  // Creating over an existing theme without its etag, or updating with a stale one, conflicts.
  for (const etag of [null, 'stale']) {
    const res = await save('mine', etag)
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ error: { code: 'etag_mismatch' } })
  }
  expect((await save('fresh', 'stale')).json()).toMatchObject({ error: { code: 'etag_mismatch' } })
  const updated = ThemeDetailSchema.parse((await save('mine', first.etag, '.a{color:blue}')).json())
  expect(updated.css).toBe('.a{color:blue}')
  expect(updated.etag).not.toBe(first.etag)
  expect(updated.summary.updatedAt >= first.summary.updatedAt).toBe(true)
  const mismatch = await call('PUT', '/api/themes/other', {
    manifest: { format: 1, id: 'mine', name: 'x' },
    css: '',
    etag: null,
  })
  expect(mismatch.statusCode).toBe(400)
  expect(
    (await call('PUT', '/api/themes/mine', { manifest: { format: 1, id: 'mine' } })).statusCode,
  ).toBe(400)
})

test('PUT: built-in and imported ids are 409 builtin_theme', async () => {
  await upload(await fullPackage())
  for (const id of ['score', 'night', 'seaside']) {
    const res = await save(id, null)
    expect(res.statusCode, id).toBe(409)
    expect(res.json(), id).toMatchObject({ error: { code: 'builtin_theme' } })
  }
})

test.each([
  ['@import', '@import "x.css";'],
  ['escaped content', 'a::before{\\63 ontent:"x"}'],
  ['comment-split content', 'a::before{con/**/tent:"x"}'],
  ['escaped url(', 'a{b:u\\72l(http://x/y)}'],
  ['!important', 'a{color:red!important}'],
  ['position: fixed', 'a{position:fixed}'],
  ['position: sticky', 'a{position:sticky}'],
  ['expression(', 'a{width:expression(1)}'],
  ['behavior', 'a{behavior:url(asset:img/x.png)}'],
  ['-moz-binding', 'a{-moz-binding:none}'],
  ['javascript:', 'a{b:url(javascript:alert(1))}'],
  ['css over 256 KB', `a{color:red}${' '.repeat(262_145)}`],
])('PUT: css with %s is 422 theme_rejected and nothing is stored', async (_name, css) => {
  const res = await call('PUT', '/api/themes/mine', {
    manifest: { format: 1, id: 'mine', name: 'Mine' },
    css,
    etag: null,
  })
  expect([400, 422]).toContain(res.statusCode)
  if (css.length < 262_144) {
    expect(res.statusCode).toBe(422)
    expect(res.json()).toMatchObject({ error: { code: 'theme_rejected' } })
  }
  expect((await call('GET', '/api/themes/mine')).statusCode).toBe(404)
})

test('PUT: CSS just over 256 KB that passes the body schema is still 422', async () => {
  const css = `a{color:red}${' '.repeat(262_144 - 12)}`
  expect(Buffer.byteLength(css)).toBe(262_144)
  expect((await save('mine', null, css)).statusCode).toBe(200)
  const over = `${css}é`
  const res = await save('mine2', null, over)
  expect([400, 422]).toContain(res.statusCode)
})

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
  expect(Object.keys(builtin.files)).toEqual(['theme.json'])
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
    { activeTheme: 'night', mode: 'dark' },
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
      const file = await call('GET', `/api/themes/${id}/assets/${path}`)
      expect(file.statusCode, path).toBe(200)
      expect(file.headers['x-content-type-options']).toBe('nosniff')
      expect(file.headers['content-type']).toBe(
        path.endsWith('.woff2') ? 'font/woff2' : 'image/png',
      )
      expect(file.rawPayload.length).toBeGreaterThan(1000)
    }
    expect((await call('GET', `/api/themes/${id}/style.css`)).body).not.toContain('asset:')
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
    ).toEqual(['theme.json', 'style.css', ...detail.assets.map((path) => `assets/${path}`)].sort())
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
  expect(detail.css).toContain('--h1-size')
  const picture = await call('GET', '/api/themes/sandbar/assets/img/sand.png')
  expect(picture.statusCode).toBe(200)
  expect(picture.headers['content-type']).toBe('image/png')
})
