import { expect, test } from '@playwright/test'
import { writeZip } from '../apps/web/src/themes/customizer/zip.ts'
import { makePng } from './png.ts'
import { pair } from './pair.ts'
import {
  busyPicture,
  cleanUp,
  importZip,
  made,
  manifestOf,
  openCustomizer,
  tab,
  web,
} from './customizer-helpers.ts'

test('saving over a newer version says what happened, in plain words', async ({ page }) => {
  await pair(page)
  const manifest = { format: 1, id: 'e2e-clash', name: 'E2E Clash', version: '1.0.0' }
  made.add('e2e-clash')
  try {
    const put = await page.request.put('/api/themes/e2e-clash', {
      headers: web,
      data: { manifest, css: '', etag: null },
    })
    expect(put.status()).toBe(200)
    await openCustomizer(page, '/settings/look/customize/e2e-clash')
    await expect(page.getByLabel('Name', { exact: true })).toHaveValue('E2E Clash')
    // Someone else saves first.
    const current = await (await page.request.get('/api/themes/e2e-clash')).json()
    const again = await page.request.put('/api/themes/e2e-clash', {
      headers: web,
      data: {
        manifest: { ...manifest, description: 'changed elsewhere' },
        css: '',
        etag: current.etag,
      },
    })
    expect(again.status()).toBe(200)
    await tab(page, 'Shape').click()
    await page
      .getByRole('radiogroup', { name: 'Borders' })
      .getByRole('radio', { name: 'None' })
      .click()
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('changed somewhere else')
    await expect(page.getByRole('alert')).not.toContainText('etag')
    // Save as new keeps the version on screen.
    await page.getByRole('alert').getByRole('button', { name: 'Save as new…' }).click()
    await page.getByRole('dialog').getByLabel('Name').fill('E2E Clash two')
    made.add('e2e-clash-two')
    await page.getByRole('dialog').getByRole('button', { name: 'Save as new' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Saved “E2E Clash two”' })).toBeVisible(
      { timeout: 20_000 },
    )
    const two = await (await page.request.get('/api/themes/e2e-clash-two')).json()
    expect(two.manifest.shape).toEqual({ border: 'none' })
  } finally {
    await cleanUp(page)
  }
})

test('leaving with unsaved changes asks first', async ({ page }) => {
  await pair(page)
  await openCustomizer(page)
  await tab(page, 'Shape').click()
  await page
    .getByRole('radiogroup', { name: 'Shadows' })
    .getByRole('radio', { name: 'Flat' })
    .click()
  await page.locator('.cz-back').click()
  const dialog = page.getByRole('dialog', { name: 'Leave without saving?' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Keep editing' }).click()
  await expect(page).toHaveURL(/customize/)
  await page.locator('.cz-back').click()
  await page.getByRole('button', { name: 'Leave and lose changes' }).click()
  await expect(page).toHaveURL(/\/b\/settings\/look$/)
})

// ---------------------------------------------------------------------------------------------------------------
// Fix round (Codex cross-check of 9.4)

test('edits made while a save is out are kept and stay unsaved', async ({ page }) => {
  await pair(page)
  made.add('e2e-slow')
  try {
    const manifest = { format: 1, id: 'e2e-slow', name: 'E2E Slow', version: '1.0.0' }
    expect(
      (
        await page.request.put('/api/themes/e2e-slow', {
          headers: web,
          data: { manifest, css: '', etag: null },
        })
      ).status(),
    ).toBe(200)
    await openCustomizer(page, '/settings/look/customize/e2e-slow')
    await page.route('**/api/themes/e2e-slow', async (route) => {
      if (route.request().method() === 'PUT')
        await new Promise((resolve) => setTimeout(resolve, 1500))
      await route.continue()
    })
    await tab(page, 'Shape').click()
    await page
      .getByRole('radiogroup', { name: 'Borders' })
      .getByRole('radio', { name: 'Strong' })
      .click()
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Saving…' })).toBeVisible()
    // While the request is out, the person keeps editing.
    await page
      .getByRole('radiogroup', { name: 'Shadows' })
      .getByRole('radio', { name: 'Flat' })
      .click()
    await expect(page.getByRole('status').filter({ hasText: 'Saved “E2E Slow”' })).toBeVisible({
      timeout: 20_000,
    })
    await expect(page.getByText('Unsaved changes')).toBeVisible()
    await expect(
      page.getByRole('radiogroup', { name: 'Shadows' }).getByRole('radio', { name: 'Flat' }),
    ).toBeChecked()
    let stored = await (await page.request.get('/api/themes/e2e-slow')).json()
    expect(stored.manifest.shape).toEqual({ border: 'strong' })
    // The edit is still there to save.
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByText('Unsaved changes')).toHaveCount(0, { timeout: 20_000 })
    stored = await (await page.request.get('/api/themes/e2e-slow')).json()
    expect(stored.manifest.shape).toEqual({ border: 'strong', elevation: 'flat' })
  } finally {
    await cleanUp(page)
  }
})

test('a package save never overwrites a newer version (If-Match)', async ({ page }) => {
  await pair(page)
  made.add('e2e-zip')
  try {
    const png = busyPicture()
    const pkg = (name: string) =>
      writeZip([
        [
          'theme.json',
          manifestOf('e2e-zip', name, {
            background: { image: 'asset:img/b.png', fit: 'cover', dim: 0 },
          }),
        ],
        ['assets/img/b.png', new Uint8Array(png)],
      ])
    expect((await importZip(page, pkg('E2E Zip'))).status()).toBe(201)
    await openCustomizer(page, '/settings/look/customize/e2e-zip')
    await expect(page.getByLabel('Name', { exact: true })).toHaveValue('E2E Zip')
    // Someone else replaces the theme after it was opened.
    expect((await importZip(page, pkg('E2E Zip elsewhere'), '?replace=1')).status()).toBe(201)
    await page.getByLabel('Author').fill('Me')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('changed somewhere else')
    const stored = await (await page.request.get('/api/themes/e2e-zip')).json()
    expect(stored.manifest.name).toBe('E2E Zip elsewhere')
    expect(stored.manifest.author).toBeUndefined()
  } finally {
    await cleanUp(page)
  }
})

test('a custom theme with a picture saves through PUT and never overwrites a newer version', async ({
  page,
}) => {
  await pair(page)
  made.add('e2e-put')
  try {
    const png = busyPicture()
    const manifest = (name: string) => ({
      format: 1,
      id: 'e2e-put',
      name,
      version: '1.0.0',
      background: { image: 'asset:img/b.png', fit: 'cover', dim: 0 },
    })
    const put = (name: string, etag: string | null) =>
      page.request.put('/api/themes/e2e-put', {
        headers: web,
        data: {
          manifest: manifest(name),
          css: '',
          etag,
          assets: { 'img/b.png': png.toString('base64') },
        },
      })
    const first = await put('E2E Put', null)
    expect(first.status()).toBe(200)
    expect((await first.json()).summary.source).toBe('custom')
    await openCustomizer(page, '/settings/look/customize/e2e-put')
    await expect(page.getByLabel('Name', { exact: true })).toHaveValue('E2E Put')
    const methods: string[] = []
    page.on('request', (request) => {
      if (request.url().includes('/api/themes/'))
        methods.push(`${request.method()} ${new URL(request.url()).pathname}`)
    })
    // The picture stays through a plain save, without being sent again.
    await page.getByLabel('Author').fill('Me')
    const sent = page.waitForRequest((request) => request.method() === 'PUT')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    const body = (await sent).postDataJSON()
    expect(body.keep).toEqual(['img/b.png'])
    expect(body.assets).toEqual({})
    await expect(page.getByRole('status').filter({ hasText: 'Saved “E2E Put”' })).toBeVisible({
      timeout: 20_000,
    })
    expect(methods.some((entry) => entry.includes('/import'))).toBe(false)
    const stored = await (await page.request.get('/api/themes/e2e-put')).json()
    expect(stored.manifest.author).toBe('Me')
    expect(stored.assets).toEqual(['img/b.png'])
    // Someone else saves after the editor loaded; the next save is refused.
    expect((await put('E2E Put elsewhere', stored.etag)).status()).toBe(200)
    await page.getByLabel('Author').fill('Me again')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('changed somewhere else')
    expect((await (await page.request.get('/api/themes/e2e-put')).json()).manifest.name).toBe(
      'E2E Put elsewhere',
    )
  } finally {
    await cleanUp(page)
  }
})

// Re-gate finding 7: the etag the editor holds after a package save must be the one of the version it just wrote, not
// whatever a read-back finds. Another writer lands between the save and anything the client does next.
test('a writer landing right after a package save is not overwritten by the next save', async ({
  page,
}) => {
  await pair(page)
  made.add('e2e-race')
  try {
    const png = busyPicture()
    const pkg = (name: string) =>
      writeZip([
        [
          'theme.json',
          manifestOf('e2e-race', name, {
            background: { image: 'asset:img/b.png', fit: 'cover', dim: 0 },
          }),
        ],
        ['assets/img/b.png', new Uint8Array(png)],
      ])
    expect((await importZip(page, pkg('E2E Race'))).status()).toBe(201)
    await openCustomizer(page, '/settings/look/customize/e2e-race')
    await expect(page.getByLabel('Name', { exact: true })).toHaveValue('E2E Race')
    let intervened = false
    await page.route('**/api/themes/import**', async (route) => {
      const response = await route.fetch()
      // The save has committed; now another writer replaces the package, before the editor does anything else.
      if (!intervened) {
        intervened = true
        expect((await importZip(page, pkg('E2E Race elsewhere'), '?replace=1')).status()).toBe(201)
      }
      await route.fulfill({ response })
    })
    await page.getByLabel('Author').fill('Me')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Saved “' })).toBeVisible({
      timeout: 20_000,
    })
    expect(intervened).toBe(true)
    // The next save must be refused: the editor never loaded the other writer's version.
    await page.getByLabel('Author').fill('Me again')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('changed somewhere else')
    const stored = await (await page.request.get('/api/themes/e2e-race')).json()
    expect(stored.manifest.name).toBe('E2E Race elsewhere')
    expect(stored.manifest.author).toBeUndefined()
  } finally {
    await cleanUp(page)
  }
})

test('a theme in use says so: Save and apply, with a note', async ({ page }) => {
  await pair(page)
  made.add('e2e-inuse')
  made.add('e2e-idle')
  try {
    for (const [id, name] of [
      ['e2e-inuse', 'E2E In use'],
      ['e2e-idle', 'E2E Idle'],
    ])
      expect(
        (
          await page.request.put(`/api/themes/${id}`, {
            headers: web,
            data: { manifest: { format: 1, id, name, version: '1.0.0' }, css: '', etag: null },
          })
        ).status(),
      ).toBe(200)
    const note = page.getByText(/^This theme is in use\./)
    const save = page.getByRole('button', { name: /^Save( and apply)?$/ })
    // Not in use: plain Save, no note.
    await openCustomizer(page, '/settings/look/customize/e2e-idle')
    await expect(save).toHaveText('Save')
    await expect(note).toHaveCount(0)
    // This device uses it.
    await page.evaluate(() => window.localStorage.setItem('score.look.device', 'e2e-inuse'))
    await openCustomizer(page, '/settings/look/customize/e2e-inuse')
    await expect(save).toHaveText('Save and apply')
    await expect(note).toHaveText('This theme is in use. Saving changes it on this device.')
    await openCustomizer(page, '/settings/look/customize/e2e-idle')
    await expect(save).toHaveText('Save')
    await expect(note).toHaveCount(0)
    // Every device uses it (the shared theme).
    await page.evaluate(() => window.localStorage.removeItem('score.look.device'))
    await page.route('**/api/themes', async (route) => {
      if (route.request().method() !== 'GET') return route.continue()
      const response = await route.fetch()
      const body = await response.json()
      await route.fulfill({ response, json: { ...body, active: 'e2e-inuse' } })
    })
    await openCustomizer(page, '/settings/look/customize/e2e-inuse')
    await expect(save).toHaveText('Save and apply')
    await expect(note).toHaveText(
      'This theme is in use. Saving changes it on every device that uses it.',
    )
    // A built-in theme being copied is not "in use": it is a new theme.
    await openCustomizer(page, '/settings/look/customize/score')
    await expect(save).toHaveText('Save')
    await expect(note).toHaveCount(0)
  } finally {
    await page.evaluate(() => window.localStorage.removeItem('score.look.device'))
    await cleanUp(page)
  }
})

test('a picture replaced at the same path is a change and is saved', async ({ page }) => {
  await pair(page)
  made.add('e2e-swap')
  try {
    const first = makePng(40, 40, () => [255, 0, 0])
    const second = makePng(40, 40, () => [0, 0, 255])
    await openCustomizer(page)
    await page.getByLabel('Name', { exact: true }).fill('E2E Swap')
    await tab(page, 'Background').click()
    const choose = page.getByRole('tabpanel').locator('input[type=file]')
    await choose.setInputFiles({ name: 'a.png', mimeType: 'image/png', buffer: first })
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByText('Unsaved changes')).toHaveCount(0, { timeout: 20_000 })
    await tab(page, 'Background').click()
    await page
      .getByRole('tabpanel')
      .locator('input[type=file]')
      .setInputFiles({ name: 'b.png', mimeType: 'image/png', buffer: second })
    await expect(page.getByText('Unsaved changes')).toBeVisible()
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByText('Unsaved changes')).toHaveCount(0, { timeout: 20_000 })
    const detail = await (await page.request.get('/api/themes/e2e-swap')).json()
    const served = await page.request.get(
      `/api/themes/e2e-swap/assets/img/background.png?rev=${detail.etag}`,
    )
    expect(Buffer.from(await served.body()).equals(second)).toBe(true)
  } finally {
    await cleanUp(page)
  }
})
