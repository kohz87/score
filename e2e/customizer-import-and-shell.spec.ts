import { expect, test } from '@playwright/test'
import { writeZip } from '../apps/web/src/themes/customizer/zip.ts'
import { pair } from './pair.ts'
import { frame, openCustomizer, tab } from './customizer-helpers.ts'

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

// Roles, names and focus order: every control has a name, the sections are a tab list with one panel, dialogs trap focus.
test('roles, names and focus order', async ({ page }) => {
  await pair(page)
  await openCustomizer(page)
  // Focus order inside the page: the way back to Look, then the actions, then the preview's controls, then the editor.
  await page.locator('.cz-back').focus()
  const order: string[] = []
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('Tab')
    order.push(
      await page.evaluate(() => {
        const el = document.activeElement as HTMLElement
        return el.getAttribute('aria-label') ?? el.textContent?.trim() ?? el.tagName
      }),
    )
  }
  // Nothing is changed yet, so Undo, Redo and Discard are off and skipped; a new theme can be saved as it is.
  expect(order.slice(0, 3)).toEqual(['Save', 'Save as new…', 'Export'])
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
    'Background',
    'Fonts',
    'Shape',
    'Spacing',
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

// Decision 131 E: the Customizer is a part of Settings › Look in the new style, on both desktop and phone.
for (const size of [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'phone', width: 390, height: 844 },
]) {
  test(`the Customizer sits inside Settings › Look and offers the new shell's areas (${size.name})`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: size.width, height: size.height })
    await pair(page)
    // The old addresses lead there and keep the query.
    await page.goto('/settings/look/customize/score?x=1')
    await expect(page).toHaveURL(/\/b\/settings\/look\/customize\/score\?x=1$/)
    await expect(page.getByRole('heading', { name: 'Customizer' })).toBeVisible()
    // Settings frames it, with Look selected, and the way back is the Look crumb.
    const nav = page.getByRole('navigation', { name: 'Settings' })
    if (size.name === 'desktop')
      await expect(nav.getByRole('button', { name: /^Look/ })).toHaveAttribute(
        'aria-current',
        'page',
      )
    else {
      // Phone: the editor comes first; the list is one tap away.
      await expect(nav).toBeHidden()
      await page.getByRole('button', { name: /All settings/ }).click()
      await expect(page).toHaveURL(/\/b\/settings$/)
      await page.goBack()
    }
    await expect(page.locator('.cz-back')).toHaveText('Look')
    // The classic Layout and Chat tabs are gone; Spacing takes their place.
    await expect(page.getByRole('tab', { name: /^(Layout|Chat)$/ })).toHaveCount(0)
    await expect(tab(page, 'Spacing')).toBeVisible()
    await tab(page, 'Colours').click()
    const legends = await page.locator('.cz-group legend').allTextContents()
    expect(legends.map((text) => text.trim())).toEqual([
      'Ground and panels',
      'Text',
      'For you and results',
      'Lines',
      'Agent screen and code',
    ])
    // The page never grows wider than the screen.
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
    ).toBeLessThanOrEqual(1)
    // The preview offers pages of the new shell.
    if (size.name === 'phone') await page.getByRole('radio', { name: 'Preview' }).click()
    const pages = await page.getByLabel('Page to preview').locator('option').allTextContents()
    expect(pages).toEqual(['Team room', 'Agents', 'Agent page', 'Agent screen', 'Settings'])
    // The surface that asks you to decide keeps the protected marker.
    await expect(page.locator('.cz-back')).toHaveAttribute('data-protected', 'raised')
  })
}

test('phone: one pane at a time, nothing wider than the screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await pair(page)
  await page.goto('/settings/look/customize')
  await expect(page).toHaveURL(/\/b\/settings\/look\/customize$/)
  await expect(page.getByRole('heading', { name: 'Customizer' })).toBeVisible()
  await expect(page.getByRole('tablist', { name: 'Sections' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Preview' })).toBeHidden()
  const over = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(await over()).toBeLessThanOrEqual(1)
  for (const name of ['Colours', 'Spacing']) {
    await tab(page, name).click()
    expect(await over(), name).toBeLessThanOrEqual(1)
  }
  await page.getByRole('radio', { name: 'Preview' }).click()
  await expect(page.getByRole('region', { name: 'Preview' })).toBeVisible()
  await expect(frame(page).locator('[data-ui="bold"]')).toBeVisible({ timeout: 30_000 })
  expect(await over()).toBeLessThanOrEqual(1)
})
