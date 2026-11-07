import { expect, test } from '@playwright/test'
import { mockThemes, type Look } from './themes-fixtures.ts'
import { pair } from './pair.ts'
import { sheetsText } from './themes-decision.ts'
import { hostile } from './themes-safety-helpers.ts'

test.describe('the way back', () => {
  test('?look=safe skips the theme and the device choice for this visit and says so', async ({
    page,
  }) => {
    const look: Look = { active: 'hostile', mode: 'light' }
    await mockThemes(page, [hostile], look)
    await page.addInitScript(() => localStorage.setItem('score.look.device', 'hostile'))
    await pair(page)
    await page.goto('/b/settings')
    await expect(page.locator('html')).toHaveAttribute('data-look', 'custom')
    await page.goto('/b?look=safe')
    const banner = page.locator('.look-banner')
    await expect(banner).toContainText('Safe look: your theme is off for this visit')
    await expect(page.locator('html')).not.toHaveAttribute('data-look', 'custom')
    await expect(page.locator('html')).toHaveAttribute('data-pack', 'score')
    expect(await sheetsText(page)).toBe('')
    // Score's own light ground (the look's mode), not the hostile theme's #ffe0e0.
    await expect(page.locator('[data-ui="bold"]')).toHaveCSS(
      'background-color',
      'rgb(236, 238, 242)',
    )
    // The link goes to Settings › Look without leaving safe mode.
    await banner.getByRole('link', { name: 'Settings › Look' }).click()
    await expect(page).toHaveURL(/\/b\/settings\/look$/)
    await expect(page.locator('html')).not.toHaveAttribute('data-look', 'custom')
    await expect(page.getByRole('heading', { name: 'Look', exact: true })).toBeVisible()
    // The device choice is untouched: the next ordinary visit has the theme again.
    expect(await page.evaluate(() => localStorage.getItem('score.look.device'))).toBe('hostile')
    await page.goto('/b?open=1')
    await expect(page.locator('html')).toHaveAttribute('data-look', 'custom')
  })

  test('Ctrl+Shift+0 resets the look on this device', async ({ page }) => {
    const look: Look = { active: 'hostile', mode: 'light' }
    await mockThemes(page, [hostile], look)
    await pair(page)
    await page.goto('/b?open=1')
    await expect(page.locator('html')).toHaveAttribute('data-look', 'custom')
    await page.keyboard.press('Control+Shift+Digit0')
    await expect(page.locator('html')).not.toHaveAttribute('data-look', 'custom')
    expect(await page.evaluate(() => localStorage.getItem('score.look.device'))).toBe('score')
    // The old theme's cache is gone (the runtime then caches Score's own look).
    expect(
      await page.evaluate(() => JSON.parse(localStorage.getItem('score.look.cache') ?? '{}').id),
    ).not.toBe('hostile')
    await page.reload()
    await expect(page.locator('html')).not.toHaveAttribute('data-look', 'custom')
  })

  test('⌘K has “Reset look on this device”', async ({ page }) => {
    const look: Look = { active: 'hostile', mode: 'light' }
    await mockThemes(page, [hostile], look)
    await pair(page)
    await page.goto('/b?open=1')
    await expect(page.locator('html')).toHaveAttribute('data-look', 'custom')
    await page.keyboard.press('Control+k')
    const palette = page.getByRole('dialog', { name: 'Search and commands' })
    await palette.getByRole('combobox', { name: 'Search or run a command' }).fill('reset look')
    await palette.getByRole('option', { name: /Reset look on this device/ }).click()
    await expect(palette).toBeHidden()
    await expect(page.locator('html')).not.toHaveAttribute('data-look', 'custom')
  })

  test('a theme that can’t be loaded is skipped with a banner', async ({ page }) => {
    const look: Look = { active: 'gone', mode: 'light' }
    await mockThemes(page, [], look)
    await pair(page)
    await page.goto('/b?open=1')
    await expect(page.locator('.look-banner')).toContainText('Your theme couldn’t be loaded')
    await expect(page.locator('html')).not.toHaveAttribute('data-look', 'custom')
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible()
  })
})
