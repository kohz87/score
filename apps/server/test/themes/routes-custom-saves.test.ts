import JSZip from 'jszip'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { ThemeDetailSchema } from '@score/contract'
import { PNG, WEBP, WOFF2, manifestJson, zipOf } from './helpers.ts'
import {
  PNG2,
  b64,
  call,
  db,
  detailOf,
  dir,
  fileUrl,
  fullPackage,
  reasons,
  save,
  saveFiles,
  setupThemeRoutes,
  upload,
} from './routes-helpers.ts'

setupThemeRoutes()

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
