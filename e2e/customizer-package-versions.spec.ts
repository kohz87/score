import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { readZip, writeZip } from '../apps/web/src/themes/customizer/zip.ts'
import { makePng } from './png.ts'
import { pair } from './pair.ts'
import {
  cleanUp,
  importZip,
  made,
  manifestOf,
  openCustomizer,
  putSnap,
  tab,
  web,
} from './customizer-helpers.ts'

test('a copy of Ledger keeps its font and OFL.txt through save, export and import', async ({
  page,
}) => {
  test.setTimeout(120_000)
  await pair(page)
  made.add('ledger-copy')
  try {
    await openCustomizer(page, '/settings/look/customize/ledger')
    await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Ledger copy')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Saved “Ledger copy”' })).toBeVisible({
      timeout: 30_000,
    })
    const exported = await page.request.get('/api/themes/ledger-copy/export')
    const files = await readZip(new Uint8Array(await exported.body()))
    expect(files.has('OFL.txt')).toBe(true)
    expect([...files.keys()].filter((name) => name.startsWith('assets/fonts/')).length).toBe(2)
    const ofl = new TextDecoder().decode(files.get('OFL.txt'))
    expect(ofl).toBe(
      new TextDecoder().decode(
        await (async () => {
          const original = await readZip(
            new Uint8Array(await (await page.request.get('/api/themes/ledger/export')).body()),
          )
          return original.get('OFL.txt')!
        })(),
      ),
    )
    // Export from the Customizer carries it too.
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Export' }).click(),
    ])
    const fromButton = await readZip(new Uint8Array(readFileSync((await download.path())!)))
    expect(fromButton.has('OFL.txt')).toBe(true)
    // Saving again (replace) doesn't drop it.
    await tab(page, 'Shape').click()
    await page
      .getByRole('radiogroup', { name: 'Borders' })
      .getByRole('radio', { name: 'Strong' })
      .click()
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByText('Unsaved changes')).toHaveCount(0, { timeout: 30_000 })
    const again = await readZip(
      new Uint8Array(await (await page.request.get('/api/themes/ledger-copy/export')).body()),
    )
    expect(again.has('OFL.txt')).toBe(true)
    // The Import dialog accepts a package with OFL.txt.
    expect((await page.request.delete('/api/themes/ledger-copy', { headers: web })).status()).toBe(
      204,
    )
    await page
      .locator('input[aria-label="Theme file to import"]')
      .setInputFiles(await download.path())
    const dialog = page.getByRole('dialog', { name: /Install “Ledger copy”\?/ })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Install' }).click()
    await expect(page.getByRole('dialog', { name: 'Ledger copy is installed' })).toBeVisible({
      timeout: 20_000,
    })
    const back = await readZip(
      new Uint8Array(await (await page.request.get('/api/themes/ledger-copy/export')).body()),
    )
    expect(back.has('OFL.txt')).toBe(true)
  } finally {
    await page.goto('/settings')
    await cleanUp(page)
  }
})

test('a copy of Paper starts from its real manifest and saves it', async ({ page }) => {
  test.setTimeout(120_000)
  await pair(page)
  made.add('paper-copy')
  try {
    await openCustomizer(page, '/settings/look/customize/paper')
    await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Paper copy')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Saved “Paper copy”' })).toBeVisible({
      timeout: 30_000,
    })
    const saved = await (await page.request.get('/api/themes/paper-copy')).json()
    const original = await (await page.request.get('/api/themes/paper')).json()
    expect(saved.manifest.colors).toEqual(original.manifest.colors)
    expect(saved.manifest.fonts).toEqual({ heading: 'Source Serif 4' })
    expect(saved.manifest.shape).toEqual(original.manifest.shape)
    // The stored CSS is the sanitiser's own text: the same declaration, written its way.
    expect(saved.css.replace(/\s+/g, '')).toContain('--h1-size:48px')
    expect(original.css).toContain('--h1-size: 48px')
  } finally {
    await page.goto('/settings')
    await cleanUp(page)
  }
})

test('small text on a translucent glass layer is measured against what is behind it', async ({
  page,
}) => {
  await pair(page)
  await openCustomizer(page)
  await page
    .getByRole('radiogroup', { name: 'Preview colours' })
    .first()
    .getByRole('radio', { name: 'Dark' })
    .click()
  await tab(page, 'Colours').click()
  await page.getByRole('textbox', { name: 'Ground, colour value', exact: true }).fill('#000000')
  const checks = page.getByRole('region', { name: 'Contrast checks' })
  // 70% white glass over black, with #b0b0b0 text on it: a computed color(srgb …) background.
  await tab(page, 'Custom CSS').click()
  await page.locator('.cm-content').click()
  await page.keyboard.type(
    '.top { background: color-mix(in srgb, white 70%, transparent) } .word { color: #b0b0b0 }',
  )
  await expect(checks).toContainText('“score”', { timeout: 20_000 })
  await expect(checks).toContainText('hard to read over its background')
})

// J1 (fourth-gate finding 2): file URLs name the package revision, and a copy is one snapshot of it.
test('Save as new keeps one version whole: its settings with its own picture and licence', async ({
  page,
}) => {
  test.setTimeout(120_000)
  await pair(page)
  made.add('e2e-snapa')
  made.add('e2e-snap-copy')
  try {
    const first = makePng(40, 40, () => [255, 0, 0])
    const second = makePng(40, 40, () => [0, 0, 255])
    const a = await putSnap(page, 'e2e-snapa', 'E2E Snap', null, first)
    await openCustomizer(page, '/settings/look/customize/e2e-snapa')
    await expect(page.getByLabel('Name', { exact: true })).toHaveValue('E2E Snap')
    // Another editor replaces the theme, picture and licence at the same paths, after this one loaded it.
    const b = await putSnap(page, 'e2e-snapa', 'E2E Snap elsewhere', a.etag, second)
    expect(b.etag).not.toBe(a.etag)
    // The server never answers an old revision with the new bytes.
    const old = await page.request.get(`/api/themes/e2e-snapa/assets/img/b.png?rev=${a.etag}`)
    expect(old.status()).toBe(409)
    expect((await old.json()).error.code).toBe('etag_mismatch')
    const stale = await page.request.get(`/api/themes/e2e-snapa/export?rev=${a.etag}`)
    expect(stale.status()).toBe(409)
    const fresh = await page.request.get(`/api/themes/e2e-snapa/assets/img/b.png?rev=${b.etag}`)
    expect(Buffer.from(await fresh.body()).equals(second)).toBe(true)

    // The editor read its version's files when it opened the theme: the copy is that version, not a mixture.
    await page.getByLabel('Author').fill('Me')
    await page.getByRole('button', { name: 'Save as new…' }).click()
    await page.getByRole('dialog').getByLabel('Name').fill('E2E Snap copy')
    await page.getByRole('dialog').getByRole('button', { name: 'Save as new' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Saved “E2E Snap copy”' })).toBeVisible(
      { timeout: 20_000 },
    )
    const copy = await (await page.request.get('/api/themes/e2e-snap-copy')).json()
    expect(copy.manifest.author).toBe('Me')
    const bytes = await page.request.get(
      `/api/themes/e2e-snap-copy/assets/img/b.png?rev=${copy.etag}`,
    )
    expect(Buffer.from(await bytes.body()).equals(first)).toBe(true)
    const zip = await readZip(
      new Uint8Array(await (await page.request.get('/api/themes/e2e-snap-copy/export')).body()),
    )
    expect(new TextDecoder().decode(zip.get('LICENSE'))).toBe('licence of E2E Snap')
  } finally {
    await cleanUp(page)
  }
})

// L1 (1.8.1 verification, problem 4): the conflict banner promises "use Save as new to keep your version". The files
// of the version on screen are read once, when the theme is opened, so that promise holds even when the other editor
// replaced a picture or removed it.
test('Save as new after a conflict keeps the picture and licence the editor was opened with', async ({
  page,
}) => {
  test.setTimeout(120_000)
  await pair(page)
  made.add('e2e-keep')
  made.add('e2e-keep-copy')
  try {
    const first = makePng(40, 40, () => [255, 0, 0])
    const a = await putSnap(page, 'e2e-keep', 'E2E Keep', null, first)
    await openCustomizer(page, '/settings/look/customize/e2e-keep')
    await expect(page.getByLabel('Name', { exact: true })).toHaveValue('E2E Keep')
    // Another editor replaces the theme and drops the picture and the licence.
    const gone = await page.request.put('/api/themes/e2e-keep', {
      headers: web,
      data: {
        manifest: { format: 1, id: 'e2e-keep', name: 'E2E Keep elsewhere', version: '1.0.0' },
        css: '',
        etag: a.etag,
        keep: [],
        assets: {},
      },
    })
    expect(gone.status()).toBe(200)
    await page.getByLabel('Author').fill('Me')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('changed somewhere else')
    await page.getByRole('alert').getByRole('button', { name: 'Save as new…' }).click()
    await page.getByRole('dialog').getByLabel('Name').fill('E2E Keep copy')
    await page.getByRole('dialog').getByRole('button', { name: 'Save as new' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Saved “E2E Keep copy”' })).toBeVisible(
      { timeout: 20_000 },
    )
    const copy = await (await page.request.get('/api/themes/e2e-keep-copy')).json()
    expect(copy.assets).toEqual(['img/b.png'])
    const bytes = await page.request.get(
      `/api/themes/e2e-keep-copy/assets/img/b.png?rev=${copy.etag}`,
    )
    expect(Buffer.from(await bytes.body()).equals(first)).toBe(true)
    const zip = await readZip(
      new Uint8Array(await (await page.request.get('/api/themes/e2e-keep-copy/export')).body()),
    )
    expect(new TextDecoder().decode(zip.get('LICENSE'))).toBe('licence of E2E Keep')
  } finally {
    await cleanUp(page)
  }
})

test('Start from and Export keep the version they copied when the theme changed meanwhile', async ({
  page,
}) => {
  test.setTimeout(120_000)
  await pair(page)
  made.add('e2e-snapb')
  try {
    const red = makePng(40, 40, () => [255, 0, 0])
    const a = await putSnap(page, 'e2e-snapb', 'E2E Snapb', null, red)
    await openCustomizer(page)
    await tab(page, 'Theme').click()
    await page.getByLabel('Start from a theme').selectOption({ label: 'E2E Snapb' })
    await expect(
      page.getByRole('status').filter({ hasText: 'Started from “E2E Snapb”' }),
    ).toBeVisible()
    await putSnap(
      page,
      'e2e-snapb',
      'E2E Snapb elsewhere',
      a.etag,
      makePng(40, 40, () => [0, 0, 255]),
    )
    // The copy was read whole when it was started: the export is that version, picture included.
    const exported = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Export', exact: true }).click()
    const download = await exported
    await expect(page.getByRole('status').filter({ hasText: 'Exported' })).toBeVisible({
      timeout: 20_000,
    })
    const zip = await readZip(new Uint8Array(readFileSync((await download.path())!)))
    expect(Buffer.from(zip.get('assets/img/b.png')!).equals(red)).toBe(true)
    expect(new TextDecoder().decode(zip.get('LICENSE'))).toBe('licence of E2E Snapb')
    // A copy started afterwards reads the new version whole.
    await page.getByLabel('Start from a theme').selectOption({ label: 'E2E Snapb' })
    await expect(page.getByLabel('Name', { exact: true })).toHaveValue('E2E Snapb elsewhere copy')
    const again = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Export', exact: true }).click()
    const second = await readZip(new Uint8Array(readFileSync((await (await again).path())!)))
    expect(Buffer.from(second.get('assets/img/b.png')!).equals(red)).toBe(false)
    expect(new TextDecoder().decode(second.get('LICENSE'))).toBe('licence of E2E Snapb elsewhere')
  } finally {
    await cleanUp(page)
  }
})

// L1: a theme replaced while the editor reads its files (409) is read again once; a second miss is said plainly.
test('opening a theme that changes under the read reloads it once, then says so', async ({
  page,
}) => {
  test.setTimeout(120_000)
  await pair(page)
  made.add('e2e-open')
  try {
    await putSnap(
      page,
      'e2e-open',
      'E2E Open',
      null,
      makePng(40, 40, () => [255, 0, 0]),
    )
    let refuse = 1
    await page.route('**/api/themes/e2e-open/assets/**', (route) => {
      if (refuse === 0) return route.fallback()
      refuse--
      return route.fulfill({
        status: 409,
        json: { error: { code: 'etag_mismatch', message: 'changed' } },
      })
    })
    await openCustomizer(page, '/settings/look/customize/e2e-open')
    await expect(page.getByLabel('Name', { exact: true })).toHaveValue('E2E Open')
    refuse = 2
    await page.goto('/settings/look/customize/e2e-open')
    await expect(page.getByRole('alert')).toContainText(
      'This theme changed while you were copying it. Reload and try again.',
    )
  } finally {
    await cleanUp(page)
  }
})

test('a look cached before 1.8.1 (file URLs without a revision) still loads and is rewritten', async ({
  page,
}) => {
  await pair(page)
  made.add('e2e-snapc')
  try {
    const a = await putSnap(
      page,
      'e2e-snapc',
      'E2E Snap',
      null,
      makePng(40, 40, () => [255, 0, 0]),
    )
    await page.goto('/settings')
    await page.evaluate(() => {
      window.localStorage.setItem('score.look.device', 'e2e-snapc')
      window.localStorage.setItem(
        'score.look.cache',
        JSON.stringify({
          id: 'e2e-snapc',
          attributes: { 'data-look': 'custom' },
          css: ':root:root[data-look=\'custom\'] body{background-image:url("/api/themes/e2e-snapc/assets/img/b.png")}',
        }),
      )
    })
    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('data-look', 'custom')
    await expect
      .poll(async () => page.evaluate(() => window.localStorage.getItem('score.look.cache') ?? ''))
      .toContain(`/assets/img/b.png?rev=${a.etag}`)
    await expect
      .poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundImage))
      .toContain(`?rev=${a.etag}`)
  } finally {
    await page.evaluate(() => window.localStorage.removeItem('score.look.device'))
    await cleanUp(page)
  }
})

// X3 (cross-audit): the import dialog's Replace is conditional on the theme it showed.
test('Replace in the install preview never overwrites a version that landed after it opened', async ({
  page,
}) => {
  await pair(page)
  made.add('e2e-imp')
  try {
    const pkg = (name: string) => writeZip([['theme.json', manifestOf('e2e-imp', name)]])
    expect((await importZip(page, pkg('E2E Imp'))).status()).toBe(201)
    await openCustomizer(page)
    await page.locator('input[aria-label="Theme file to import"]').setInputFiles({
      name: 'imp.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from(pkg('E2E Imp from file')),
    })
    const dialog = page.getByRole('dialog', { name: 'Install “E2E Imp from file”?' })
    await dialog.getByRole('checkbox').check()
    await expect(dialog.getByRole('button', { name: 'Install' })).toBeEnabled()
    // Someone else replaces the theme while the dialog is open.
    expect((await importZip(page, pkg('E2E Imp elsewhere'), '?replace=1')).status()).toBe(201)
    await dialog.getByRole('button', { name: 'Install' }).click()
    await expect(dialog.getByRole('alert')).toContainText('changed')
    const stored = await (await page.request.get('/api/themes/e2e-imp')).json()
    expect(stored.manifest.name).toBe('E2E Imp elsewhere')
    // The person is asked to look again: the dialog does not install on a second click.
    await expect(dialog.getByRole('button', { name: 'Install' })).toBeDisabled()
  } finally {
    await cleanUp(page)
  }
})

// X13 (cross-audit): a picture replaced at the same path reaches the device that saved it, through its new revision.
test('a replaced picture at the same path is fetched again on the saving device', async ({
  page,
}) => {
  test.setTimeout(120_000)
  await pair(page)
  made.add('e2e-livea')
  try {
    const first = makePng(40, 40, () => [255, 0, 0])
    const second = makePng(40, 40, () => [0, 0, 255])
    const a = await putSnap(page, 'e2e-livea', 'E2E Live', null, first)
    await page.goto('/settings')
    await page.evaluate(() => window.localStorage.setItem('score.look.device', 'e2e-livea'))
    await openCustomizer(page, '/settings/look/customize/e2e-livea')
    await expect(page.locator('html')).toHaveAttribute('data-look', 'custom')
    const background = () => page.evaluate(() => getComputedStyle(document.body).backgroundImage)
    await expect.poll(background).toContain(`/assets/img/b.png?rev=${a.etag}`)
    await tab(page, 'Background').click()
    await page
      .getByRole('tabpanel')
      .locator('input[type=file]')
      .setInputFiles({ name: 'b.png', mimeType: 'image/png', buffer: second })
    await page.getByRole('button', { name: 'Save and apply' }).click()
    await expect(page.getByText('Unsaved changes')).toHaveCount(0, { timeout: 20_000 })
    const stored = await (await page.request.get('/api/themes/e2e-livea')).json()
    expect(stored.etag).not.toBe(a.etag)
    await expect.poll(background).toContain(`/assets/img/background.png?rev=${stored.etag}`)
    const url = /url\("([^"]+background\.png[^"]*)"\)/.exec(await background())![1]!
    const served = await page.request.get(url)
    expect(served.status()).toBe(200)
    expect(Buffer.from(await served.body()).equals(second)).toBe(true)
  } finally {
    await page.evaluate(() => window.localStorage.removeItem('score.look.device'))
    await cleanUp(page)
  }
})
