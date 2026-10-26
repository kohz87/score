import { expect, test, type Page } from '@playwright/test'
import { openWithTheme } from './themes-layout-fixtures.ts'

// Baselines for the Customizer (PLAN 9.4; in Settings › Look since 2.7.0) on the frozen visual data: light, dark and phone width. The default look's
// baselines (visual.spec.ts, packs-visual.spec.ts, ...) are untouched by this file.
test.use({ timezoneId: 'UTC', locale: 'en-GB' })

type Variant = 'light' | 'dark' | 'phone'
const widths: Record<Variant, number> = { light: 1440, dark: 1440, phone: 390 }

async function open(page: Page, variant: Variant) {
  const mode = variant === 'dark' ? 'dark' : 'light'
  await page.setViewportSize({ width: widths[variant], height: variant === 'phone' ? 900 : 1000 })
  await page.addInitScript((m) => localStorage.setItem('score.theme', m), mode)
  await openWithTheme(page, [], { active: 'score', mode })
  // The frozen data has no room, questions or watch overview: the new shell's pages in the preview read them as
  // "none yet" (404), the same on every run.
  await page.route(
    /\/api\/(questions|team-room|watch\/overview|knowledge\/notes\/|tasks\?needsYou)/,
    (route) =>
      route.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'none' } } }),
  )
  await page.goto('/b/settings/look/customize')
  await expect(page.getByRole('heading', { name: 'Customizer' })).toBeVisible()
  if (variant !== 'phone') {
    const frame = page.frameLocator('iframe[title="Preview of your theme"]')
    // The Team page reads only what the frozen data holds (the room would wait for its own).
    await page.getByLabel('Page to preview').selectOption({ label: 'Team' })
    await expect(frame.getByRole('heading', { name: 'Your team', level: 1 })).toBeVisible({
      timeout: 30_000,
    })
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
      .getByRole('tab', { name: variant === 'dark' ? 'Spacing' : 'Colours', exact: true })
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
  await page.getByLabel('Page to preview').selectOption({ label: 'Team' })
  const frame = page.frameLocator('iframe[title="Preview of your theme"]')
  await expect(frame.getByRole('heading', { name: 'Your team', level: 1 })).toBeVisible({
    timeout: 30_000,
  })
  await page.waitForTimeout(800)
  await expect(page).toHaveScreenshot('customizer-phone-preview.png', {
    fullPage: true,
    animations: 'disabled',
    maxDiffPixelRatio: 0.01,
  })
})
