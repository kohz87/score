import { expect, test, type Page } from '@playwright/test'
import { openWithTheme } from './themes-layout-fixtures.ts'

// Baselines for the Customizer (PLAN 9.4) on the frozen visual data: light, dark and phone width. The default look's
// baselines (visual.spec.ts, packs-visual.spec.ts, ...) are untouched by this file.
test.use({ timezoneId: 'UTC', locale: 'en-GB' })

type Variant = 'light' | 'dark' | 'phone'
const widths: Record<Variant, number> = { light: 1440, dark: 1440, phone: 390 }

async function open(page: Page, variant: Variant) {
  const mode = variant === 'dark' ? 'dark' : 'light'
  await page.setViewportSize({ width: widths[variant], height: variant === 'phone' ? 900 : 1000 })
  await page.addInitScript((m) => localStorage.setItem('score.theme', m), mode)
  // The full-screen classic Customizer: the bold shell frames it since 2.0.2.
  await page.addInitScript(() => localStorage.setItem('score.ui', 'classic'))
  await openWithTheme(page, [], { active: 'score', mode })
  await page.goto('/settings/look/customize')
  await expect(page.getByRole('heading', { name: 'Customize' })).toBeVisible()
  if (variant !== 'phone') {
    const frame = page.frameLocator('iframe[title="Preview of your theme"]')
    await expect(frame.locator('.page-content')).toBeVisible({ timeout: 30_000 })
    await expect(frame.getByText(/^Loading/)).toHaveCount(0)
    await expect(frame.locator('html[data-motion]')).toHaveCount(0)
    await page.evaluate(() => document.fonts.ready)
    await expect(page.getByRole('region', { name: 'Contrast checks' })).toContainText(
      'No contrast problems',
    )
  }
  await page.waitForTimeout(600)
}

for (const variant of ['light', 'dark', 'phone'] as const) {
  test(`Customizer, ${variant}`, async ({ page }) => {
    await open(page, variant)
    await page
      .getByRole('tab', { name: variant === 'dark' ? 'Layout' : 'Colours', exact: true })
      .click()
    await expect(page).toHaveScreenshot(`customizer-${variant}.png`, {
      fullPage: variant === 'phone',
      animations: 'disabled',
      maxDiffPixelRatio: 0.01,
    })
  })
}

test('Customizer, phone preview', async ({ page }) => {
  await open(page, 'phone')
  await page.getByRole('radio', { name: 'Preview' }).click()
  const frame = page.frameLocator('iframe[title="Preview of your theme"]')
  await expect(frame.locator('.page-content')).toBeVisible({ timeout: 30_000 })
  await page.waitForTimeout(800)
  await expect(page).toHaveScreenshot('customizer-phone-preview.png', {
    fullPage: true,
    animations: 'disabled',
    maxDiffPixelRatio: 0.01,
  })
})
