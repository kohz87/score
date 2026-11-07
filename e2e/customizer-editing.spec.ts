import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { readZip } from '../apps/web/src/themes/customizer/zip.ts'
import { pair } from './pair.ts'
import {
  busyPicture,
  cleanUp,
  frame,
  made,
  openCustomizer,
  tab,
  web,
} from './customizer-helpers.ts'

test('builds a theme from scratch, saves, exports, re-imports and uses it; the draft stays in the preview', async ({
  page,
}) => {
  test.setTimeout(180_000)
  await pair(page)
  try {
    await page.goto('/b/settings/look')
    await page.getByRole('link', { name: 'Open the Customizer' }).click()
    await expect(page.getByRole('heading', { name: 'Customizer' })).toBeVisible()
    await expect(page).toHaveURL(/\/b\/settings\/look\/customize\/[^/]+$/)
    // A built-in style is copied, not edited: the draft starts as a new theme.
    await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Score copy')
    const cacheBefore = await page.evaluate(() => window.localStorage.getItem('score.look.cache'))
    await page.getByLabel('Name', { exact: true }).fill('E2E Harbour')
    made.add('e2e-harbour')
    await page.getByLabel('Author').fill('Test Author')

    await tab(page, 'Colours').click()
    await page.getByRole('textbox', { name: 'Ground, colour value', exact: true }).fill('#dfe9ef')

    await tab(page, 'Shape').click()
    await page
      .getByRole('radiogroup', { name: 'Card surface' })
      .getByRole('radio', { name: 'Glass' })
      .click()

    await tab(page, 'Spacing').click()
    await page
      .getByRole('radiogroup', { name: 'Corners' })
      .getByRole('radio', { name: 'Round' })
      .click()
    await page
      .getByRole('radiogroup', { name: 'Spacing' })
      .getByRole('radio', { name: 'Airy' })
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
    await expect(inner).toHaveAttribute('data-density', 'airy')
    await expect(inner).toHaveAttribute('data-surface', 'glass')
    const outside = await page.evaluate(() => ({
      look: document.documentElement.getAttribute('data-look'),
      density: document.documentElement.getAttribute('data-density'),
      cache: window.localStorage.getItem('score.look.cache'),
      device: window.localStorage.getItem('score.look.device'),
      adopted: document.adoptedStyleSheets.length,
      previewStyles: document.querySelectorAll('style[data-preview-look]').length,
      bootStyle: !!document.getElementById('score-look-boot'),
    }))
    expect(outside).toEqual({
      look: null,
      density: 'comfortable',
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
      shape: { radius: 'round', surface: 'glass', density: 'airy' },
      background: { image: 'asset:img/background.png' },
    })
    expect(saved.manifest.layout).toBeUndefined()
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
      'airy spacing',
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
    await expect(page.locator('html')).toHaveAttribute('data-look', 'custom', { timeout: 20_000 })
    await expect(page.locator('html')).toHaveAttribute('data-density', 'airy')
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
  await page.keyboard.press('ArrowRight')
  await expect(tab(page, 'Spacing')).toBeFocused()

  // A choice moves with the arrow keys.
  const spacing = page.getByRole('radiogroup', { name: 'Spacing' })
  await spacing.getByRole('radio', { name: 'Score’s' }).focus()
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await expect(spacing.getByRole('radio', { name: 'Comfortable' })).toBeChecked()
  await expect(frame(page).locator('html')).toHaveAttribute('data-density', 'comfortable')
  await page.keyboard.press('ArrowRight')
  await expect(frame(page).locator('html')).toHaveAttribute('data-density', 'airy')

  // Undo and redo by keyboard, outside a text field.
  await page.getByRole('radio', { name: 'Compact' }).click()
  await expect(frame(page).locator('html')).toHaveAttribute('data-density', 'compact')
  await page.keyboard.press('Control+z')
  await expect(frame(page).locator('html')).not.toHaveAttribute('data-density', 'compact')
  await page.keyboard.press('Control+Shift+z')
  await expect(frame(page).locator('html')).toHaveAttribute('data-density', 'compact')
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
  await page.getByRole('textbox', { name: 'Text, colour value', exact: true }).fill('#c9ccd2')
  const checks = page.getByRole('region', { name: 'Contrast checks' })
  await expect(checks).toContainText('Main text on cards is hard to read')
  await expect(page.getByText('Hard to read on “Panels”')).toBeVisible()
  await page.getByRole('textbox', { name: 'Text, colour value', exact: true }).fill('not a colour')
  await expect(page.getByRole('alert').filter({ hasText: 'Use a hex colour' })).toBeVisible()
  await page.getByRole('button', { name: 'Use Score’s text', exact: true }).click()
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
