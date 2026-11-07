import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { ThemeDetailSchema, ThemeImportResultSchema, ThemeListSchema } from '@score/contract'
import { buildZip, unicodePathExtra } from '@score/contract/test/theme-package-zip'
import { multipart } from '../media-fixtures.ts'
import { readThemePackage } from '../../src/themes/package.ts'
import { PNG, manifestJson, rawZip, zipOf } from './helpers.ts'
import {
  app,
  call,
  dir,
  events,
  fullPackage,
  headers,
  reasons,
  save,
  setupThemeRoutes,
  upload,
} from './routes-helpers.ts'

setupThemeRoutes()

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
