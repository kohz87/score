import JSZip from 'jszip'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
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
import { resetLook } from '../../src/themes/look.ts'
import { checkThemeCss } from '../../src/themes/css-check.ts'
import { manifestAssets, readThemePackage } from '../../src/themes/package.ts'
import { buildZip, unicodePathExtra } from '@score/contract/test/theme-package-zip'
import { AVIF, JPEG, PNG, WEBP, WOFF2, manifestJson, rawZip, zipOf, type Entry } from './helpers.ts'

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
/** A theme file URL bound to the theme's current revision (contract § 16, J1). */
const fileUrl = async (id: string, path: string) =>
  `/api/themes/${id}/${path}?rev=${ThemeDetailSchema.parse((await call('GET', `/api/themes/${id}`)).json()).etag}`
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
  const rev = ThemeDetailSchema.parse((await call('GET', '/api/themes/seaside')).json()).etag
  expect(res.body).toBe(`.a{background:url(/api/themes/seaside/assets/img/a.png?rev=${rev})}`)
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

test('import: ?replace=1 with If-Match replaces only a theme whose etag still matches', async () => {
  await upload(await fullPackage())
  const first = ThemeDetailSchema.parse((await call('GET', '/api/themes/seaside')).json())
  const next = (name: string) => zipOf({ 'theme.json': manifestJson({ name }) })
  const withEtag = (etag: string, quoted = false) => ({
    ...headers,
    'if-match': quoted ? `"${etag}"` : etag,
  })
  // A matching etag (quotes allowed) replaces.
  expect(
    (await upload(await next('Seaside B'), '?replace=1', withEtag(first.etag, true))).statusCode,
  ).toBe(201)
  const second = ThemeDetailSchema.parse((await call('GET', '/api/themes/seaside')).json())
  expect(second.summary.name).toBe('Seaside B')
  // The stale etag of the first read no longer matches: 409 with the current etag, and the theme is unchanged.
  const stale = await upload(await next('Seaside C'), '?replace=1', withEtag(first.etag))
  expect(stale.statusCode).toBe(409)
  expect(stale.json()).toMatchObject({
    error: { code: 'etag_mismatch', details: { etag: second.etag } },
  })
  const after = ThemeDetailSchema.parse((await call('GET', '/api/themes/seaside')).json())
  expect(after).toEqual(second)
  // Without the header replace works as before; a theme that is gone doesn't match any etag.
  expect((await upload(await next('Seaside D'), '?replace=1')).statusCode).toBe(201)
  await call('DELETE', '/api/themes/seaside')
  const gone = await upload(await next('Seaside E'), '?replace=1', withEtag(second.etag))
  expect(gone.statusCode).toBe(409)
  expect(gone.json()).toMatchObject({ error: { code: 'etag_mismatch', details: { etag: null } } })
  expect((await call('GET', '/api/themes/seaside')).statusCode).toBe(404)
})

// Gate finding #1: the Customizer previews the central directory; the server must not install what the local headers say.
test('import: a package whose local headers and central directory disagree changes no theme', async () => {
  await upload(await fullPackage())
  const before = ThemeDetailSchema.parse((await call('GET', '/api/themes/seaside')).json())
  const shown = manifestJson({ name: 'Shown' })
  const hidden = manifestJson({ name: 'Installed' })
  const attack = rawZip([
    { name: 'theme.json', localName: 'style.css', data: shown },
    { name: 'style.css', localName: 'theme.json', data: hidden },
  ])
  const res = await upload(attack, '?replace=1', { ...headers, 'if-match': before.etag })
  expect(res.statusCode).toBe(422)
  expect(reasons(res)).toMatch(/headers don.t match/)
  const after = ThemeDetailSchema.parse((await call('GET', '/api/themes/seaside')).json())
  expect(after).toEqual(before)
  const dup = rawZip([
    { name: 'theme.json', data: shown },
    { name: 'theme.json', data: hidden },
  ])
  expect((await upload(dup, '?replace=1')).statusCode).toBe(422)
  expect(ThemeDetailSchema.parse((await call('GET', '/api/themes/seaside')).json())).toEqual(before)
})

// Re-gate finding 1: Unicode path extra fields rename entries for JSZip only; the replace must not reach the store.
test('import: a package whose Unicode path fields rename its entries changes no theme', async () => {
  await upload(await fullPackage())
  const before = ThemeDetailSchema.parse((await call('GET', '/api/themes/seaside')).json())
  const attack = Buffer.from(
    buildZip([
      {
        name: 'theme.json',
        data: manifestJson({ id: 'reviewed', name: 'Reviewed' }),
        centralExtra: unicodePathExtra('theme.json', 'LICENSE'),
        localExtra: unicodePathExtra('theme.json', 'LICENSE'),
      },
      {
        name: 'OFL.txt',
        data: manifestJson({ id: 'seaside', name: 'Installed instead' }),
        centralExtra: unicodePathExtra('OFL.txt', 'theme.json'),
        localExtra: unicodePathExtra('OFL.txt', 'theme.json'),
      },
    ]),
  )
  const res = await upload(attack, '?replace=1', { ...headers, 'if-match': before.etag })
  expect(res.statusCode).toBe(422)
  expect(ThemeDetailSchema.parse((await call('GET', '/api/themes/seaside')).json())).toEqual(before)
  expect((await call('GET', '/api/themes/reviewed')).statusCode).toBe(404)
})

// Re-gate finding 2: while a swap note can't be settled, the id is not written (replace, custom save, delete).
test('an id with an unsettled swap note answers 409 theme_recovering until it is settled', async () => {
  await upload(await fullPackage())
  db.sqlite
    .prepare(
      "INSERT INTO theme_swaps (token, kind, theme_id, other_id, had_folder, created_at) VALUES ('dead', 'swap', 'seaside', NULL, 1, 'x')",
    )
    .run()
  // Erasing the note fails, so recovery keeps it, as it would after a failed move back.
  db.sqlite.exec(
    "CREATE TRIGGER keep_notes BEFORE DELETE ON theme_swaps BEGIN SELECT RAISE(ABORT, 'injected'); END;",
  )
  const replaced = await upload(await fullPackage('seaside', '.b{color:red}'), '?replace=1')
  expect(replaced.statusCode).toBe(409)
  expect(replaced.json()).toMatchObject({ error: { code: 'theme_recovering' } })
  expect((await call('DELETE', '/api/themes/seaside')).json()).toMatchObject({
    error: { code: 'theme_recovering' },
  })
  db.sqlite.exec('DROP TRIGGER keep_notes')
  expect(
    (await upload(await fullPackage('seaside', '.b{color:red}'), '?replace=1')).statusCode,
  ).toBe(201)
})

// Third gate finding 4: package reads of an id with an unsettled note are refused, never mixed.
test('detail, style.css, assets and export answer 409 theme_recovering while a note is unsettled', async () => {
  await upload(await fullPackage())
  const asset = await fileUrl('seaside', 'assets/img/a.png')
  expect((await call('GET', asset)).statusCode).toBe(200)
  db.sqlite
    .prepare(
      "INSERT INTO theme_swaps (token, kind, theme_id, other_id, had_folder, created_at) VALUES ('dead', 'swap', 'seaside', NULL, 1, 'x')",
    )
    .run()
  db.sqlite.exec(
    "CREATE TRIGGER keep_notes BEFORE DELETE ON theme_swaps BEGIN SELECT RAISE(ABORT, 'injected'); END;",
  )
  for (const path of [
    '/api/themes/seaside',
    '/api/themes/seaside/style.css',
    asset,
    '/api/themes/seaside/export',
  ]) {
    const res = await call('GET', path)
    expect([path, res.statusCode]).toEqual([path, 409])
    expect(res.json()).toMatchObject({ error: { code: 'theme_recovering' } })
  }
  // Other themes and the list keep working.
  expect((await call('GET', '/api/themes/harbour')).statusCode).toBe(200)
  expect((await call('GET', '/api/themes')).statusCode).toBe(200)
  db.sqlite.exec('DROP TRIGGER keep_notes')
  expect((await call('GET', '/api/themes/seaside')).statusCode).toBe(200)
  expect((await call('GET', asset)).statusCode).toBe(200)
})

// Third gate finding 4: a start that cannot settle a note still comes up; only that id is refused.
test('a start that keeps a failed note logs it, serves the other themes, and refuses reads of that id', async () => {
  await upload(await fullPackage())
  db.sqlite
    .prepare(
      "INSERT INTO theme_swaps (token, kind, theme_id, other_id, had_folder, created_at) VALUES ('dead', 'swap', 'seaside', NULL, 1, 'x')",
    )
    .run()
  db.sqlite.exec(
    "CREATE TRIGGER keep_notes BEFORE DELETE ON theme_swaps BEGIN SELECT RAISE(ABORT, 'injected'); END;",
  )
  const warnings: unknown[] = []
  const second = buildApp({
    config: loadConfig({ SCORE_MODE: 'fake', SCORE_HOME: dir }),
    logger: { level: 'warn', stream: { write: (line: string) => warnings.push(JSON.parse(line)) } },
    db,
    ingest,
    port,
  })
  try {
    const pairedAgain = await second.inject({
      method: 'POST',
      url: '/api/session/pair',
      headers: { 'x-score-client': 'web' },
      payload: { token: second.pairing.createToken() },
    })
    const cookie = pairedAgain.headers['set-cookie']!.toString().split(';')[0]!
    const get = (url: string) =>
      second.inject({ method: 'GET', url, headers: { 'x-score-client': 'web', cookie } })
    expect((await get('/api/themes/harbour')).statusCode).toBe(200)
    expect((await get('/api/themes/seaside')).statusCode).toBe(409)
    expect(JSON.stringify(warnings)).toContain('seaside')
  } finally {
    await second.close()
  }
})

// Re-gate finding 7: the import answers with the version it committed, etag included.
test('import: the result carries the committed ThemeDetail, new and replaced', async () => {
  const first = ThemeImportResultSchema.parse((await upload(await fullPackage())).json())
  expect(first.detail).toEqual(
    ThemeDetailSchema.parse((await call('GET', '/api/themes/seaside')).json()),
  )
  const again = await upload(await fullPackage('seaside', '.b{color:red}'), '?replace=1', {
    ...headers,
    'if-match': first.detail.etag,
  })
  expect(again.statusCode).toBe(201)
  const second = ThemeImportResultSchema.parse(again.json())
  expect(second.detail.etag).not.toBe(first.detail.etag)
  expect(second.detail.css).toBe('.b{color:red}')
  expect(second.detail).toEqual(
    ThemeDetailSchema.parse((await call('GET', '/api/themes/seaside')).json()),
  )
})

// Gate finding #7: the etag must change with every byte of the package, not only the manifest and the CSS.
test('import: If-Match covers asset bytes and licence files, so a stale replace is refused', async () => {
  const pkg = (png: Buffer, licence?: string) =>
    zipOf({
      'theme.json': manifestJson(),
      'style.css': '.a{background:url(asset:img/a.png)}',
      'assets/img/a.png': png,
      ...(licence === undefined ? {} : { LICENSE: licence }),
    })
  const etagOf = async () =>
    ThemeDetailSchema.parse((await call('GET', '/api/themes/seaside')).json()).etag
  const conditional = (etag: string) => ({ ...headers, 'if-match': etag })
  expect((await upload(await pkg(PNG, 'MIT one'))).statusCode).toBe(201)
  const e1 = await etagOf()

  // Asset-only change: two clients start from e1; the first wins, the second must be refused.
  const other = Buffer.concat([PNG, Buffer.from('different pixels')])
  expect(
    (await upload(await pkg(other, 'MIT one'), '?replace=1', conditional(e1))).statusCode,
  ).toBe(201)
  const e2 = await etagOf()
  expect(e2).not.toBe(e1)
  const staleAsset = await upload(await pkg(PNG, 'MIT one'), '?replace=1', conditional(e1))
  expect(staleAsset.statusCode).toBe(409)
  expect(staleAsset.json()).toMatchObject({
    error: { code: 'etag_mismatch', details: { etag: e2 } },
  })
  expect(readFileSync(join(dir, 'themes/seaside/assets/img/a.png'))).toEqual(other)

  // Licence-only change.
  expect(
    (await upload(await pkg(other, 'MIT two'), '?replace=1', conditional(e2))).statusCode,
  ).toBe(201)
  const e3 = await etagOf()
  expect(e3).not.toBe(e2)
  const staleLicence = await upload(await pkg(other, 'MIT three'), '?replace=1', conditional(e2))
  expect(staleLicence.statusCode).toBe(409)
  const exported = await readThemePackage(
    (await call('GET', '/api/themes/seaside/export')).rawPayload,
  )
  expect(exported.licenses).toEqual({ LICENSE: 'MIT two' })
  expect((await call('GET', '/api/themes/seaside')).json()).toMatchObject({ etag: e3 })

  // An identical re-import is a new revision too: whoever read before it must reload.
  expect(
    (await upload(await pkg(other, 'MIT two'), '?replace=1', conditional(e3))).statusCode,
  ).toBe(201)
  expect(await etagOf()).not.toBe(e3)
})

test('start-up undoes a swap that stopped before its row was committed', async () => {
  await upload(await fullPackage())
  // A stop after the old folder went aside and the new one was moved in, before the row was written.
  db.sqlite
    .prepare(
      "INSERT INTO theme_swaps (token, kind, theme_id, other_id, had_folder, created_at) VALUES ('t1', 'swap', 'seaside', NULL, 1, 'now')",
    )
    .run()
  renameSync(join(dir, 'themes/seaside'), join(dir, 'themes/.old-t1'))
  mkdirSync(join(dir, 'themes/seaside/assets/img'), { recursive: true })
  writeFileSync(join(dir, 'themes/seaside/assets/img/a.png'), 'half-written')
  const second = buildApp({
    config: loadConfig({ SCORE_MODE: 'fake', SCORE_HOME: dir }),
    logger: false,
    db,
    ingest,
    port,
  })
  await second.ready()
  expect(readFileSync(join(dir, 'themes/seaside/assets/img/a.png'))).toEqual(PNG)
  expect(readdirSync(join(dir, 'themes')).filter((name) => name.startsWith('.'))).toEqual([])
  await second.close()
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
  expect(reasons(res)).toMatch(/content can’t be set by a theme/)
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
      /content can’t be set by a theme/,
    ],
    [
      'comment-split keyword',
      await zipOf({ 'theme.json': manifestJson(), 'style.css': 'a::before{con/**/tent:"x"}' }),
      /can’t be set by a theme/,
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

// C4 #2: a custom save can carry files (the Customizer saves a picture or a font without the import-replace route).
const PNG2 = Buffer.concat([PNG, Buffer.from(' changed')])
const b64 = (bytes: Buffer) => bytes.toString('base64')
const saveFiles = (id: string, etag: string | null, files: object, css = '', extra: object = {}) =>
  call('PUT', `/api/themes/${id}`, {
    manifest: { format: 1, id, name: id, ...extra },
    css,
    etag,
    ...files,
  })
const detailOf = async (id: string) =>
  ThemeDetailSchema.parse((await call('GET', `/api/themes/${id}`)).json())

test('PUT can add assets and licence files to a custom theme; they are served and exported', async () => {
  const OFL = 'SIL Open Font License text'
  const res = await saveFiles(
    'mine',
    null,
    {
      assets: { 'img/a.png': b64(PNG), 'fonts/f.woff2': b64(WOFF2) },
      licenses: { 'OFL.txt': OFL },
    },
    '.a{background:url(asset:img/a.png)}',
  )
  expect(res.statusCode, res.body).toBe(200)
  const first = ThemeDetailSchema.parse(res.json())
  expect(first.summary.source).toBe('custom')
  expect(first.assets).toEqual(['fonts/f.woff2', 'img/a.png'])
  const asset = await call('GET', await fileUrl('mine', 'assets/img/a.png'))
  expect(asset.statusCode).toBe(200)
  expect(asset.rawPayload.equals(PNG)).toBe(true)
  const exported = await JSZip.loadAsync((await call('GET', '/api/themes/mine/export')).rawPayload)
  expect(Object.keys(exported.files).sort()).toEqual([
    'OFL.txt',
    'assets/fonts/f.woff2',
    'assets/img/a.png',
    'style.css',
    'theme.json',
  ])
  expect(await exported.files['OFL.txt']!.async('string')).toBe(OFL)
})

test('PUT with files accepts repetitive CSS that a save without files accepts (no compression ratio of its own)', async () => {
  // C4 cross-check #1: the in-memory package used for the checks must not be compressed, or valid CSS trips the ratio rule.
  const css = '.a{color:red}'.repeat(6000)
  const res = await saveFiles('mine', null, { assets: { 'img/a.png': b64(PNG) } }, css)
  expect(res.statusCode, res.body).toBe(200)
  expect((await detailOf('mine')).css).toBe(css)
})

test('PUT: keep, assets and licenses decide the files; none of them leaves the files alone', async () => {
  const created = await saveFiles(
    'mine',
    null,
    {
      assets: { 'img/a.png': b64(PNG), 'fonts/f.woff2': b64(WOFF2) },
      licenses: { LICENSE: 'MIT' },
    },
    '.a{background:url(asset:img/a.png)}',
  )
  const first = ThemeDetailSchema.parse(created.json())
  // No file fields: the files stay, licences included (the behaviour before C4).
  const plain = ThemeDetailSchema.parse((await save('mine', first.etag, '.a{color:red}')).json())
  expect(plain.assets).toEqual(['fonts/f.woff2', 'img/a.png'])
  // keep + one new file: the kept file stays, the unnamed one goes, the licence is kept (omitted).
  const next = await saveFiles(
    'mine',
    plain.etag,
    { keep: ['img/a.png'], assets: { 'img/b.webp': b64(WEBP) } },
    '.a{background:url(asset:img/a.png)}',
  )
  expect(next.statusCode, next.body).toBe(200)
  const second = ThemeDetailSchema.parse(next.json())
  expect(second.assets).toEqual(['img/a.png', 'img/b.webp'])
  expect(second.etag).not.toBe(plain.etag)
  const exported = await JSZip.loadAsync((await call('GET', '/api/themes/mine/export')).rawPayload)
  expect(await exported.files['LICENSE']!.async('string')).toBe('MIT')
  // Only assets: every current file is kept (keep omitted) and a file of the same path is replaced.
  const replaced = await saveFiles(
    'mine',
    second.etag,
    { assets: { 'img/a.png': b64(PNG2) } },
    '',
    {},
  )
  expect(ThemeDetailSchema.parse(replaced.json()).assets).toEqual(['img/a.png', 'img/b.webp'])
  expect(
    (await call('GET', await fileUrl('mine', 'assets/img/a.png'))).rawPayload.equals(PNG2),
  ).toBe(true)
  // keep: [] drops them all.
  const cleared = await saveFiles('mine', (await detailOf('mine')).etag, { keep: [] })
  expect(ThemeDetailSchema.parse(cleared.json()).assets).toEqual([])
})

test('PUT with files runs the import checks: same reasons, and nothing changes when it fails', async () => {
  const first = ThemeDetailSchema.parse(
    (await saveFiles('mine', null, { assets: { 'img/a.png': b64(PNG) } })).json(),
  )
  const before = await detailOf('mine')
  const fakeFont = Buffer.from('not a font at all')
  const attempts: [string, object, string, RegExp][] = [
    ['bytes that are not the type', { assets: { 'fonts/f.woff2': b64(fakeFont) } }, '', /woff2/],
    [
      'a used file that is missing',
      { keep: ['img/a.png'] },
      '.a{background:url(asset:img/gone.png)}',
      /gone\.png/,
    ],
    ['a kept file the theme lacks', { keep: ['img/gone.png'] }, '', /img\/gone\.png/],
    [
      'a manifest picture that is missing',
      { keep: ['img/a.png'] },
      '',
      /asset:img\/nope\.png is used but not in the package/,
    ],
  ]
  for (const [name, files, css, expected] of attempts) {
    const extra =
      name === 'a manifest picture that is missing'
        ? { background: { image: 'asset:img/nope.png' } }
        : {}
    const res = await saveFiles('mine', first.etag, files, css, extra)
    expect(res.statusCode, name).toBe(422)
    expect(res.json(), name).toMatchObject({ error: { code: 'theme_rejected' } })
    expect(reasons(res), name).toMatch(expected)
    expect(await detailOf('mine'), name).toEqual(before)
  }
  // The reasons are the import's own: the same bytes in a zip say the same thing.
  const imported = await upload(
    await zipOf({
      'theme.json': manifestJson({ id: 'viaimport' }),
      'assets/fonts/f.woff2': fakeFont,
    }),
  )
  expect(imported.statusCode).toBe(422)
  const viaPut = await saveFiles('viaput', null, { assets: { 'fonts/f.woff2': b64(fakeFont) } })
  expect(reasons(viaPut)).toBe(reasons(imported))
})

test('PUT with files: stale etag is 409 and the files stay; bad base64 or paths are 400', async () => {
  const first = ThemeDetailSchema.parse(
    (await saveFiles('mine', null, { assets: { 'img/a.png': b64(PNG) } })).json(),
  )
  const stale = await saveFiles('mine', 'stale', { assets: { 'img/b.png': b64(PNG) } })
  expect(stale.statusCode).toBe(409)
  expect(stale.json()).toMatchObject({ error: { code: 'etag_mismatch' } })
  expect((await detailOf('mine')).assets).toEqual(['img/a.png'])
  // A second writer that lands first makes the next file save stale too.
  await save('mine', first.etag, '.x{color:red}')
  expect((await saveFiles('mine', first.etag, { keep: [] })).statusCode).toBe(409)
  expect((await detailOf('mine')).assets).toEqual(['img/a.png'])
  for (const files of [
    { assets: { 'img/a.png': 'not base64!' } },
    { assets: { 'img/a.png': 'abc' } },
    { assets: { '../x.png': b64(PNG) } },
    { assets: { 'img/a.svg': b64(PNG) } },
    { keep: ['css/a.png'] },
    { licenses: { 'NOTICE.txt': 'x' } },
  ])
    expect((await saveFiles('mine', (await detailOf('mine')).etag, files)).statusCode).toBe(400)
})

test('PUT with files cannot touch built-in or imported themes, and waits for an unsettled swap', async () => {
  await upload(await fullPackage())
  for (const id of ['paper', 'seaside']) {
    const res = await saveFiles(id, null, { assets: { 'img/a.png': b64(PNG) } })
    expect(res.statusCode, id).toBe(409)
    expect(res.json(), id).toMatchObject({ error: { code: 'builtin_theme' } })
  }
  const mine = ThemeDetailSchema.parse(
    (await saveFiles('mine', null, { assets: { 'img/a.png': b64(PNG) } })).json(),
  )
  db.sqlite
    .prepare(
      "INSERT INTO theme_swaps (token, kind, theme_id, other_id, had_folder, created_at) VALUES ('dead', 'swap', 'mine', NULL, 1, 'x')",
    )
    .run()
  db.sqlite.exec(
    "CREATE TRIGGER keep_notes BEFORE DELETE ON theme_swaps BEGIN SELECT RAISE(ABORT, 'injected'); END;",
  )
  const res = await saveFiles('mine', mine.etag, { assets: { 'img/b.png': b64(PNG) } })
  expect(res.statusCode).toBe(409)
  expect(res.json()).toMatchObject({ error: { code: 'theme_recovering' } })
  // Reads are refused too while the note stands (I2); the files on disk are still the first save's.
  expect((await call('GET', '/api/themes/mine')).statusCode).toBe(409)
  expect(existsSync(join(dir, 'themes', 'mine', 'assets', 'img', 'a.png'))).toBe(true)
  expect(existsSync(join(dir, 'themes', 'mine', 'assets', 'img', 'b.png'))).toBe(false)
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

test('starting Score after an upgrade moves a theme that has a now built-in id, and the look follows it', async () => {
  // As an earlier Score left it: a theme called "ledger" with assets, active for every device.
  const first = await upload(await fullPackage('seaside'))
  expect(first.statusCode).toBe(201)
  const folder = join(dir, 'themes')
  const row = db.sqlite.prepare('SELECT manifest_json FROM themes WHERE id = ?').get('seaside') as {
    manifest_json: string
  }
  db.sqlite
    .prepare("UPDATE themes SET id = 'ledger', manifest_json = ? WHERE id = 'seaside'")
    .run(JSON.stringify({ ...JSON.parse(row.manifest_json), id: 'ledger' }))
  renameSync(join(folder, 'seaside'), join(folder, 'ledger'))
  db.sqlite.prepare("UPDATE meta SET value = 'ledger' WHERE key = 'look.activeTheme'").run()

  // A fresh start of the app on that data.
  const restarted = buildApp({
    config: loadConfig({ SCORE_MODE: 'fake', SCORE_HOME: dir }),
    logger: false,
    db,
    ingest,
    port,
  })
  try {
    const paired = await restarted.inject({
      method: 'POST',
      url: '/api/session/pair',
      headers: { 'x-score-client': 'web' },
      payload: { token: restarted.pairing.createToken() },
    })
    const h = {
      'x-score-client': 'web',
      cookie: paired.headers['set-cookie']!.toString().split(';')[0]!,
    }
    const get = (url: string) => restarted.inject({ method: 'GET', url, headers: h })
    const list = ThemeListSchema.parse((await get('/api/themes')).json())
    expect(list.active).toBe('ledger-mine')
    expect(list.items.filter((item) => item.id === 'ledger')).toHaveLength(1)
    expect(list.items.find((item) => item.id === 'ledger')!.source).toBe('builtin')
    expect(list.items.find((item) => item.id === 'ledger-mine')).toMatchObject({
      source: 'imported',
      name: 'seaside (yours)',
    })
    const mine = ThemeDetailSchema.parse((await get('/api/themes/ledger-mine')).json())
    expect(mine.assets).toEqual(['fonts/f.woff2', 'img/a.png'])
    expect(mine.manifest.id).toBe('ledger-mine')
    expect(
      (await get(`/api/themes/ledger-mine/assets/img/a.png?rev=${mine.etag}`)).statusCode,
    ).toBe(200)
    const builtin = ThemeDetailSchema.parse((await get('/api/themes/ledger')).json())
    expect(builtin.summary.source).toBe('builtin')
    // It can be edited and deleted again (the look moves off it first).
    const put = await restarted.inject({
      method: 'PUT',
      url: '/api/look',
      headers: h,
      payload: { activeTheme: 'score', mode: 'system' },
    })
    expect(put.statusCode).toBe(204)
    const del = await restarted.inject({
      method: 'DELETE',
      url: '/api/themes/ledger-mine',
      headers: h,
    })
    expect(del.statusCode).toBe(204)
  } finally {
    await restarted.close()
  }
})

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

  // The stylesheet names the revision it was made from, and refuses a stale one.
  expect((await call('GET', `/api/themes/mine/style.css?rev=${a.etag}`)).statusCode).toBe(409)
  const css = await call('GET', `/api/themes/mine/style.css?rev=${b.etag}`)
  expect(css.body).toBe(`.a{background:url(/api/themes/mine/assets/img/a.png?rev=${b.etag})}`)
  expect((await call('GET', '/api/themes/mine/style.css')).body).toBe(css.body)
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
