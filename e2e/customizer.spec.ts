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
    await page.goto('/settings#look')
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
    await page.getByRole('button', { name: 'Move Chat up' }).click()
    await page.getByLabel('Name of Chat in the menu').fill('Talk')
    await page.getByLabel('Name of Chat in the menu').press('Enter')
    await page.getByRole('button', { name: 'Hide Reports from the menu' }).click()

    await tab(page, 'Now').click()
    await page.getByRole('button', { name: 'Arrange the cards' }).click()
    await page.getByRole('button', { name: 'Move Room up' }).click()

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
    await page.keyboard.type('.now-score { content: "x" } .brand-subtitle { letter-spacing: 1px }')
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
      { to: '/now' },
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
  const moveDown = page.getByRole('button', { name: 'Move Now down' })
  await moveDown.focus()
  await page.keyboard.press('Enter')
  await expect(
    page.getByRole('status').filter({ hasText: 'Now moved to position 2 of 7' }),
  ).toBeVisible()
  await expect(frame(page).locator('.main-nav-link').first()).toHaveText('Chat')
  const grip = page.getByRole('button', { name: /^Reorder Now:/ })
  await grip.focus()
  await page.keyboard.press('ArrowUp')
  await expect(frame(page).locator('.main-nav-link').first()).toHaveText('Now')
  // Hidden pages can be brought back, and Settings can't be hidden.
  await page.getByRole('button', { name: 'Hide Tasks from the menu' }).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('list', { name: 'Hidden from the menu' })).toContainText('Tasks')
  await expect(page.getByRole('button', { name: 'Hide Settings from the menu' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Show Tasks in the menu' }).focus()
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

  // Now cards: width, order and removal without a pointer.
  await tab(page, 'Now').click()
  await page.getByRole('button', { name: 'Arrange the cards' }).click()
  await page.getByRole('button', { name: 'Move Made today up' }).focus()
  await page.keyboard.press('Enter')
  await expect(
    page.getByRole('status').filter({ hasText: /Made today moved to position/ }),
  ).toBeVisible()
  await page.getByLabel('Width of Room').selectOption('3')
  await expect(page.getByRole('button', { name: 'Remove Needs you from Now' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Remove To do from Now' }).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: 'Add To do' })).toBeVisible()
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
      text('.chat-approval { color: red } .brand-subtitle { z-index: 999; letter-spacing: 1px }'),
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
  await expect(removed).toContainText('z-index above 50')
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
    await page.goto('/settings#look')
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
  // Nothing is changed yet, so Undo, Redo, Discard and Save are off and skipped.
  expect(order.slice(0, 4)).toEqual(['Settings', 'Save as new…', 'Export', 'Import…'])
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
    'Now',
    'Chat',
    'Background',
    'Custom CSS',
  ]) {
    await tab(page, name).click()
    if (name === 'Now') await page.getByRole('button', { name: 'Arrange the cards' }).click()
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
  for (const name of ['Colours', 'Layout', 'Now']) {
    await tab(page, name).click()
    if (name === 'Now') await page.getByRole('button', { name: 'Arrange the cards' }).click()
    expect(await over(), name).toBeLessThanOrEqual(1)
  }
  await page.getByRole('radio', { name: 'Preview' }).click()
  await expect(page.getByRole('region', { name: 'Preview' })).toBeVisible()
  await expect(frame(page).locator('.page-content')).toBeVisible({ timeout: 30_000 })
  expect(await over()).toBeLessThanOrEqual(1)
})
