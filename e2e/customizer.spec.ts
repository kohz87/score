import { expect, test, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { readZip, writeZip } from '../apps/web/src/themes/customizer/zip.ts'
import { makePng } from './png.ts'
import { pair } from './pair.ts'

// The theme Customizer (PLAN 9.4) against the real server in fake mode: a theme built from scratch, saved, exported,
// removed, re-imported through the install preview and used; the draft never leaves the preview; keyboard-only editing;
// roles and names. Themes made here are deleted at the end so other specs see the same list as before.

const web = { 'x-score-client': 'web' }
const made = new Set<string>()

async function cleanUp(page: Page) {
  for (const id of made) await page.request.delete(`/api/themes/${id}`, { headers: web })
  made.clear()
}

const frame = (page: Page) => page.frameLocator('iframe[title="Preview of your theme"]')
const tab = (page: Page, name: string) => page.getByRole('tab', { name, exact: true })

async function openCustomizer(page: Page, path = '/settings/look/customize') {
  await page.goto(path)
  await expect(page.getByRole('heading', { name: 'Customize' })).toBeVisible()
  await expect(frame(page).locator('.page-content')).toBeVisible({ timeout: 30_000 })
}

const busyPicture = () =>
  makePng(120, 80, (x, y) => (((x >> 3) + (y >> 3)) % 2 === 0 ? [255, 255, 255] : [20, 20, 90]))

test('builds a theme from scratch, saves, exports, re-imports and uses it; the draft stays in the preview', async ({
  page,
}) => {
  test.setTimeout(180_000)
  await pair(page)
  try {
    await page.goto('/settings/look')
    await page.getByRole('link', { name: 'Customize…' }).click()
    await expect(page.getByRole('heading', { name: 'Customize' })).toBeVisible()
    await expect(page).toHaveURL(/\/settings\/look\/customize\/score$/)
    // A built-in style is copied, not edited: the draft starts as a new theme.
    await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Score copy')
    const cacheBefore = await page.evaluate(() => window.localStorage.getItem('score.look.cache'))
    await page.getByLabel('Name', { exact: true }).fill('E2E Harbour')
    made.add('e2e-harbour')
    await page.getByLabel('Author').fill('Test Author')

    await tab(page, 'Colours').click()
    await page.getByRole('textbox', { name: 'Page background, colour value' }).fill('#dfe9ef')

    await tab(page, 'Shape').click()
    await page
      .getByRole('radiogroup', { name: 'Corners' })
      .getByRole('radio', { name: 'Round' })
      .click()
    await page
      .getByRole('radiogroup', { name: 'Card surface' })
      .getByRole('radio', { name: 'Glass' })
      .click()

    await tab(page, 'Layout').click()
    await page
      .getByRole('radiogroup', { name: 'Navigation' })
      .getByRole('radio', { name: 'Left rail' })
      .click()
    await page.getByLabel('Name of Chat in the menu').fill('Talk')
    await page.getByLabel('Name of Chat in the menu').press('Enter')
    await page.getByRole('button', { name: 'Hide Reports from the menu' }).click()

    await tab(page, 'Chat').click()
    await page
      .getByRole('radiogroup', { name: 'Messages' })
      .getByRole('radio', { name: 'Bubbles' })
      .click()

    await tab(page, 'Background').click()
    await page.getByRole('tabpanel').locator('input[type=file]').setInputFiles({
      name: 'sea.png',
      mimeType: 'image/png',
      buffer: busyPicture(),
    })
    await expect(page.getByRole('img', { name: 'The chosen background picture' })).toBeVisible()

    await tab(page, 'Custom CSS').click()
    await page.locator('.cm-content').click()
    await page.keyboard.type('.chat-thread { content: "x" } .brand-subtitle { font-weight: 600 }')
    await expect(page.getByRole('region', { name: 'What the checks removed' })).toContainText(
      '1 rule was removed',
    )
    await expect(page.getByRole('region', { name: 'What the checks removed' })).toContainText(
      'content property',
    )

    // The draft is painted in the preview frame only.
    const inner = frame(page).locator('html')
    await expect(inner).toHaveAttribute('data-look', 'custom')
    await expect(inner).toHaveAttribute('data-nav', 'left')
    await expect(inner).toHaveAttribute('data-chat', 'bubbles')
    await expect(inner).toHaveAttribute('data-surface', 'glass')
    await expect(frame(page).locator('.main-nav-link').first()).toHaveText('Talk')
    await expect(frame(page).locator('.main-nav-link', { hasText: 'Reports' })).toHaveCount(0)
    const outside = await page.evaluate(() => ({
      look: document.documentElement.getAttribute('data-look'),
      nav: document.documentElement.getAttribute('data-nav'),
      cache: window.localStorage.getItem('score.look.cache'),
      device: window.localStorage.getItem('score.look.device'),
      adopted: document.adoptedStyleSheets.length,
      previewStyles: document.querySelectorAll('style[data-preview-look]').length,
      bootStyle: !!document.getElementById('score-look-boot'),
    }))
    expect(outside).toEqual({
      look: null,
      nav: null,
      cache: cacheBefore,
      device: null,
      adopted: 0,
      previewStyles: 0,
      bootStyle: false,
    })
    await expect(page.getByText('Unsaved changes')).toBeVisible()

    // A second window (another device) sees nothing of the draft.
    const other = await page.context().newPage()
    await other.goto('/settings')
    await expect(other.locator('html')).not.toHaveAttribute('data-look', /.+/)
    expect(await other.evaluate(() => window.localStorage.getItem('score.look.cache'))).toBe(
      cacheBefore,
    )
    await other.close()
    expect(await (await page.request.get('/api/themes/e2e-harbour')).status()).toBe(404)

    // Save: the theme has a picture, so it travels as a package.
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Saved “E2E Harbour”' })).toBeVisible({
      timeout: 20_000,
    })
    await expect(page.getByText('Unsaved changes')).toHaveCount(0)
    await expect(page).toHaveURL(/customize\/e2e-harbour$/)
    const saved = await (await page.request.get('/api/themes/e2e-harbour')).json()
    expect(saved.manifest).toMatchObject({
      id: 'e2e-harbour',
      name: 'E2E Harbour',
      author: 'Test Author',
      shape: { radius: 'round', surface: 'glass' },
      layout: { nav: 'left', chat: { messages: 'bubbles' } },
      background: { image: 'asset:img/background.png' },
    })
    expect(saved.manifest.layout.menu.slice(0, 2)).toEqual([
      { to: '/chat', label: 'Talk' },
      { to: '/team' },
    ])
    expect(saved.manifest.layout.menu.some((m: { to: string }) => m.to === '/reports')).toBe(false)
    expect(saved.assets).toEqual(['img/background.png'])
    // Saving didn't switch anything on.
    await expect(page.locator('html')).not.toHaveAttribute('data-look', /.+/)

    // Export: a zip of the theme.
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Export' }).click(),
    ])
    expect(download.suggestedFilename()).toBe('e2e-harbour.zip')
    const zipPath = await download.path()
    const files = await readZip(new Uint8Array(readFileSync(zipPath)))
    expect([...files.keys()].sort()).toEqual([
      'assets/img/background.png',
      'style.css',
      'theme.json',
    ])
    expect(JSON.parse(new TextDecoder().decode(files.get('theme.json')))).toMatchObject({
      id: 'e2e-harbour',
    })

    // Remove it, then bring it back through the install preview.
    await page.goto('/settings')
    expect((await page.request.delete('/api/themes/e2e-harbour', { headers: web })).status()).toBe(
      204,
    )
    await openCustomizer(page)
    await page.locator('input[aria-label="Theme file to import"]').setInputFiles(zipPath)
    const dialog = page.getByRole('dialog', { name: 'Install “E2E Harbour”?' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText('Test Author')).toBeVisible()
    await expect(dialog.getByRole('region', { name: 'What it changes' })).toContainText(
      'navigation as a rail on the left',
    )
    // The CSS was cleaned when it was saved, so the file carries nothing the checks would remove.
    await expect(dialog.getByRole('region', { name: 'What the checks removed' })).toContainText(
      'Nothing was removed.',
    )
    // Nothing is stored until Install.
    expect((await page.request.get('/api/themes/e2e-harbour')).status()).toBe(404)
    await dialog.getByRole('button', { name: 'Install' }).click()
    await expect(page.getByRole('dialog', { name: 'E2E Harbour is installed' })).toBeVisible({
      timeout: 20_000,
    })
    expect((await page.request.get('/api/themes/e2e-harbour')).status()).toBe(200)
    await expect(page.locator('html')).not.toHaveAttribute('data-look', /.+/)
    await page.getByRole('button', { name: 'Open in the Customizer' }).click()
    await expect(page).toHaveURL(/customize\/e2e-harbour$/)
    await expect(page.getByLabel('Name', { exact: true })).toHaveValue('E2E Harbour')

    // Use it on this device: now the page wears it.
    await page.getByRole('button', { name: 'Use on this device' }).click()
    await expect(page.locator('html')).toHaveAttribute('data-nav', 'left', { timeout: 20_000 })
    await expect(page.locator('html')).toHaveAttribute('data-look', 'custom')
    expect(await page.evaluate(() => window.localStorage.getItem('score.look.device'))).toBe(
      'e2e-harbour',
    )
  } finally {
    await page.goto('/settings')
    await page.evaluate(() => window.localStorage.removeItem('score.look.device'))
    await cleanUp(page)
  }
})

test('keyboard only: sections, choices, moving rows, undo and redo', async ({ page }) => {
  await pair(page)
  await openCustomizer(page)
  // Sections are a tab list: arrows move between them.
  await tab(page, 'Theme').focus()
  await page.keyboard.press('ArrowRight')
  await expect(tab(page, 'Colours')).toBeFocused()
  await expect(tab(page, 'Colours')).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('End')
  await expect(tab(page, 'Custom CSS')).toBeFocused()
  await page.keyboard.press('Home')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await expect(tab(page, 'Layout')).toBeFocused()

  // A choice moves with the arrow keys.
  const nav = page.getByRole('radiogroup', { name: 'Navigation' })
  await nav.getByRole('radio', { name: 'Score’s' }).focus()
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await expect(nav.getByRole('radio', { name: 'Left rail' })).toBeChecked()
  await expect(frame(page).locator('html')).toHaveAttribute('data-nav', 'left')

  // Menu rows: the buttons, and the arrow keys on the handle.
  const moveDown = page.getByRole('button', { name: 'Move Chat down' })
  await moveDown.focus()
  await page.keyboard.press('Enter')
  await expect(
    page.getByRole('status').filter({ hasText: 'Chat moved to position 2 of 5' }),
  ).toBeVisible()
  await expect(frame(page).locator('.main-nav-link').first()).toHaveText('Team')
  const grip = page.getByRole('button', { name: /^Reorder Chat:/ })
  await grip.focus()
  await page.keyboard.press('ArrowUp')
  await expect(frame(page).locator('.main-nav-link').first()).toHaveText('Chat')
  // Hidden pages can be brought back, and Settings can't be hidden.
  await page.getByRole('button', { name: 'Hide Knowledge from the menu' }).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('list', { name: 'Hidden from the menu' })).toContainText('Knowledge')
  await expect(page.getByRole('button', { name: 'Hide Settings from the menu' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Show Knowledge in the menu' }).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('list', { name: 'Hidden from the menu' })).toHaveCount(0)

  // Undo and redo by keyboard, outside a text field.
  await page
    .getByRole('radiogroup', { name: 'Page width' })
    .getByRole('radio', { name: 'Narrow' })
    .click()
  await expect(frame(page).locator('html')).toHaveAttribute('data-width', 'narrow')
  await page.keyboard.press('Control+z')
  await expect(frame(page).locator('html')).not.toHaveAttribute('data-width', 'narrow')
  await page.keyboard.press('Control+Shift+z')
  await expect(frame(page).locator('html')).toHaveAttribute('data-width', 'narrow')
})

test('Discard goes back to the saved theme and Undo brings the changes back', async ({ page }) => {
  await pair(page)
  await openCustomizer(page)
  await tab(page, 'Shape').click()
  await page
    .getByRole('radiogroup', { name: 'Borders' })
    .getByRole('radio', { name: 'Strong' })
    .click()
  await expect(page.getByText('Unsaved changes')).toBeVisible()
  await page.getByRole('button', { name: 'Discard' }).click()
  await expect(page.getByText('Unsaved changes')).toHaveCount(0)
  await expect(frame(page).locator('html')).not.toHaveAttribute('data-border', 'strong')
  await page.getByRole('button', { name: 'Undo' }).click()
  await expect(frame(page).locator('html')).toHaveAttribute('data-border', 'strong')
  await page.getByRole('button', { name: 'Redo' }).click()
  await expect(frame(page).locator('html')).not.toHaveAttribute('data-border', 'strong')
})

test('contrast: a faint colour is named, and small text over a picture is measured', async ({
  page,
}) => {
  await pair(page)
  await openCustomizer(page)
  await tab(page, 'Colours').click()
  await page.getByRole('textbox', { name: 'Main text, colour value' }).fill('#c9ccd2')
  const checks = page.getByRole('region', { name: 'Contrast checks' })
  await expect(checks).toContainText('Main text on cards is hard to read')
  await expect(page.getByText('Hard to read on “Card background”')).toBeVisible()
  await page.getByRole('textbox', { name: 'Main text, colour value' }).fill('not a colour')
  await expect(page.getByRole('alert').filter({ hasText: 'Use a hex colour' })).toBeVisible()
  await page.getByRole('button', { name: 'Use Score’s main text' }).click()
  await expect(checks).toContainText('No contrast problems found')

  // A busy picture behind glass cards: the text that is really drawn is measured against it.
  await tab(page, 'Background').click()
  await page.getByRole('tabpanel').locator('input[type=file]').setInputFiles({
    name: 'busy.png',
    mimeType: 'image/png',
    buffer: busyPicture(),
  })
  await expect(checks).toContainText('hard to read over its background', { timeout: 20_000 })
})

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
  await page.getByRole('link', { name: 'Settings' }).click()
  const dialog = page.getByRole('dialog', { name: 'Leave without saving?' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Keep editing' }).click()
  await expect(page).toHaveURL(/customize/)
  await page.getByRole('link', { name: 'Settings' }).click()
  await page.getByRole('button', { name: 'Leave and lose changes' }).click()
  await expect(page).toHaveURL(/\/settings/)
})

test('the install preview lists what the checks removed, and Cancel stores nothing', async ({
  page,
}) => {
  await pair(page)
  await openCustomizer(page)
  const text = (value: string) => new TextEncoder().encode(value)
  const zip = writeZip([
    [
      'theme.json',
      text(JSON.stringify({ format: 1, id: 'e2e-preview', name: 'E2E Preview', version: '1.0.0' })),
    ],
    [
      'style.css',
      text('.chat-approval { color: red } .brand-subtitle { z-index: 999; font-weight: 600 }'),
    ],
  ])
  await page.locator('input[aria-label="Theme file to import"]').setInputFiles({
    name: 'preview.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from(zip),
  })
  const dialog = page.getByRole('dialog', { name: 'Install “E2E Preview”?' })
  const removed = dialog.getByRole('region', { name: 'What the checks removed' })
  await expect(removed).toContainText('2 rules were removed')
  await expect(removed).toContainText('approvals, security screens')
  await expect(removed).toContainText('.brand-subtitle { z-index }')
  await expect(removed).toContainText(
    '`z-index`: This property isn’t on the list a theme may change',
  )
  await expect(dialog.getByRole('region', { name: 'What it changes' })).toContainText('Custom CSS')
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toHaveCount(0)
  expect((await page.request.get('/api/themes/e2e-preview')).status()).toBe(404)
})

test('an import that can’t be used is explained and nothing is sent', async ({ page }) => {
  await pair(page)
  await openCustomizer(page)
  let sent = 0
  await page.route('**/api/themes/import**', (route) => {
    sent += 1
    return route.fulfill({ status: 500 })
  })
  await page.locator('input[aria-label="Theme file to import"]').setInputFiles({
    name: 'nope.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from('this is not a zip'),
  })
  const dialog = page.getByRole('dialog', { name: 'This file can’t be installed' })
  await expect(dialog).toContainText('nope.zip')
  await expect(dialog).toContainText('isn’t a zip file')
  await dialog.getByRole('button', { name: 'Close' }).click()
  expect(sent).toBe(0)
})

test('Settings › Look shows an added theme in its own colours', async ({ page }) => {
  await pair(page)
  made.add('e2e-swatch')
  try {
    const put = await page.request.put('/api/themes/e2e-swatch', {
      headers: web,
      data: {
        manifest: {
          format: 1,
          id: 'e2e-swatch',
          name: 'E2E Swatch',
          version: '1.0.0',
          colors: {
            light: { ground: '#ffe9d6', card: '#fffaf5', ink: '#4a1d00', 'link-hover': '#d9480f' },
          },
        },
        css: '',
        etag: null,
      },
    })
    expect(put.status()).toBe(200)
    await page.addInitScript(() => window.localStorage.setItem('score.theme', 'light'))
    await page.goto('/settings/look')
    const card = page.getByRole('radio', { name: /E2E Swatch/ })
    const preview = card.locator('.look-pack-preview')
    await expect(preview).toBeVisible()
    await expect
      .poll(() => preview.evaluate((el) => getComputedStyle(el).backgroundColor))
      .toBe('rgb(255, 233, 214)')
    expect(
      await preview
        .locator('.look-pack-button')
        .evaluate((el) => getComputedStyle(el).backgroundColor),
    ).toBe('rgb(217, 72, 15)')
    // The built-in cards are as they were.
    const score = page.getByRole('radio', { name: /^Score/ }).locator('.look-pack-preview')
    expect(await score.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
      'rgb(236, 238, 242)',
    )
  } finally {
    await cleanUp(page)
  }
})

// Roles, names and focus order: every control has a name, the sections are a tab list with one panel, dialogs trap focus.
test('roles, names and focus order', async ({ page }) => {
  await pair(page)
  await openCustomizer(page)
  // Focus order: back link, then the actions, then the preview's controls, then the editor.
  await page.locator('body').click({ position: { x: 1, y: 1 } })
  const order: string[] = []
  for (let i = 0; i < 11; i++) {
    await page.keyboard.press('Tab')
    order.push(
      await page.evaluate(() => {
        const el = document.activeElement as HTMLElement
        return el.getAttribute('aria-label') ?? el.textContent?.trim() ?? el.tagName
      }),
    )
  }
  // Nothing is changed yet, so Undo, Redo and Discard are off and skipped; a new theme can be saved as it is.
  expect(order.slice(0, 4)).toEqual(['Settings', 'Save', 'Save as new…', 'Export'])
  const unnamed = async () => {
    const snapshot = await page.locator('.cz').ariaSnapshot()
    return snapshot
      .split('\n')
      .filter((line) =>
        /^\s*- (button|link|textbox|combobox|radio|checkbox|slider|tab)\b/.test(line),
      )
      .filter((line) => !line.includes('"'))
  }
  for (const name of [
    'Theme',
    'Colours',
    'Fonts',
    'Shape',
    'Layout',
    'Chat',
    'Background',
    'Custom CSS',
  ]) {
    await tab(page, name).click()
    expect(await unnamed(), `controls without a name in “${name}”`).toEqual([])
    await expect(page.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', /cz-tab-/)
  }
  await expect(page.getByRole('tablist', { name: 'Sections' })).toBeVisible()
  await expect(page.getByRole('toolbar', { name: 'Theme actions' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Preview' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Edit the theme' })).toBeVisible()
  await expect(page.locator('iframe[title="Preview of your theme"]')).toBeVisible()
  // The preview is read-only: nothing in it can take focus.
  expect(
    await frame(page)
      .locator('#root')
      .evaluate((el) => (el as HTMLElement).inert),
  ).toBe(true)

  // A dialog traps focus and gives it back.
  await page.getByRole('button', { name: 'Save as new…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Save as a new theme' })
  await expect(dialog.getByLabel('Name')).toBeFocused()
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('Tab')
    expect(await page.evaluate(() => !!document.activeElement?.closest('[role=dialog]'))).toBe(true)
  }
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Save as new…' })).toBeFocused()
})

test('phone: one pane at a time, nothing wider than the screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await pair(page)
  await page.goto('/settings/look/customize')
  await expect(page.getByRole('heading', { name: 'Customize' })).toBeVisible()
  await expect(page.getByRole('tablist', { name: 'Sections' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Preview' })).toBeHidden()
  const over = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(await over()).toBeLessThanOrEqual(1)
  for (const name of ['Colours', 'Layout']) {
    await tab(page, name).click()
    expect(await over(), name).toBeLessThanOrEqual(1)
  }
  await page.getByRole('radio', { name: 'Preview' }).click()
  await expect(page.getByRole('region', { name: 'Preview' })).toBeVisible()
  await expect(frame(page).locator('.page-content')).toBeVisible({ timeout: 30_000 })
  expect(await over()).toBeLessThanOrEqual(1)
})

// ---------------------------------------------------------------------------------------------------------------
// Fix round (Codex cross-check of 9.4)

const importZip = (page: Page, zip: Uint8Array, query = '') =>
  page.request.post(`/api/themes/import${query}`, {
    headers: web,
    multipart: {
      file: { name: 'theme.zip', mimeType: 'application/zip', buffer: Buffer.from(zip) },
    },
  })
const textOf = (value: string) => new TextEncoder().encode(value)
const manifestOf = (id: string, name: string, extra: object = {}) =>
  textOf(JSON.stringify({ format: 1, id, name, version: '1.0.0', ...extra }))

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
  await page.getByRole('textbox', { name: 'Page background, colour value' }).fill('#000000')
  const checks = page.getByRole('region', { name: 'Contrast checks' })
  // 70% white glass over black, with #b0b0b0 text on it: a computed color(srgb …) background.
  await tab(page, 'Custom CSS').click()
  await page.locator('.cm-content').click()
  await page.keyboard.type(
    '.top-bar { background: color-mix(in srgb, white 70%, transparent) } .brand-subtitle { color: #b0b0b0 }',
  )
  await expect(checks).toContainText('“for Hermes”', { timeout: 20_000 })
  await expect(checks).toContainText('hard to read over its background')
})

// J1 (fourth-gate finding 2): file URLs name the package revision, and a copy is one snapshot of it.
const snapManifest = (id: string, name: string) => ({
  format: 1,
  id,
  name,
  version: '1.0.0',
  background: { image: 'asset:img/b.png', fit: 'cover', dim: 0 },
})
async function putSnap(page: Page, id: string, name: string, etag: string | null, picture: Buffer) {
  const res = await page.request.put(`/api/themes/${id}`, {
    headers: web,
    data: {
      manifest: snapManifest(id, name),
      css: '',
      etag,
      assets: { 'img/b.png': picture.toString('base64') },
      licenses: { LICENSE: `licence of ${name}` },
    },
  })
  expect(res.status()).toBe(200)
  return (await res.json()) as { etag: string }
}

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
