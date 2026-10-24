import { expect, test, type Page } from '@playwright/test'
import { pair } from './pair.ts'
import { packagedThemeIds } from './themes-builtin-fixtures.ts'

// Review screenshots for 9.5 from the real fake-mode Score (the built-in themes served by the server, picked as this
// device's own look). Only runs when SCORE_UI_SHOTS_DIR names a folder.
const dir = process.env.SCORE_UI_SHOTS_DIR
test.skip(!dir, 'set SCORE_UI_SHOTS_DIR to take the review screenshots')

async function settle(page: Page) {
  await expect(page.locator('html')).toHaveAttribute('data-look', 'custom')
  await expect(page.getByText(/^Loading/)).toHaveCount(0)
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(500)
}

for (const id of packagedThemeIds) {
  for (const [variant, width, mode] of [
    ['light', 1440, 'light'],
    ['dark', 1440, 'dark'],
    ['phone-light', 390, 'light'],
    ['phone-dark', 390, 'dark'],
  ] as const) {
    test(`${id} ${variant}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1000 })
      await page.addInitScript(
        ([theme, m]) => {
          localStorage.setItem('score.theme', m!)
          localStorage.setItem('score.look.device', theme!)
        },
        [id, mode],
      )
      await pair(page)
      await page.goto('/chat/room-activity-feed')
      await expect(page.locator('.chat-message').first()).toBeVisible({ timeout: 20_000 })
      await settle(page)
      await page.screenshot({ path: `${dir}/${id}-chat-${variant}.png`, fullPage: true })
    })
  }
}
