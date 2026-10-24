import { expect, test } from '@playwright/test'
import { pair } from './pair.ts'
import {
  boldThemeIds,
  rgb,
  themeColour,
  wearBuiltin,
  type BoldThemeId,
} from './themes-bold-fixtures.ts'

// PLAN 11.9d: themes and the Customizer on the new shell. A built-in theme paints the bold shell through the colours it
// sets for the classic one; the ways back work on /b; the Customizer previews the new screens.
test.use({ reducedMotion: 'reduce', viewport: { width: 1440, height: 900 } })

const themed = boldThemeIds.filter((id): id is Exclude<BoldThemeId, 'score'> => id !== 'score')

for (const id of themed) {
  for (const mode of ['light', 'dark'] as const) {
    test(`${id} paints the bold shell in ${mode}`, async ({ page }) => {
      await pair(page)
      await wearBuiltin(page, id, mode)
      await page.goto('/b/team')
      const shell = page.locator('[data-ui="bold"]')
      await expect(shell).toHaveAttribute('data-look', mode)
      await expect(page.getByRole('heading', { name: 'Your team', level: 1 })).toBeVisible()
      // The shell's ground and its panels are the theme's ground and card.
      await expect(shell).toHaveCSS('background-color', rgb(themeColour(id, mode, 'ground')))
      const panel = await page
        .locator('.bold-shell .panel, .bold-shell .card, .bold-shell [class*="team-card"]')
        .first()
        .evaluate((el) => getComputedStyle(el).backgroundColor)
      expect([rgb(themeColour(id, mode, 'card')), 'rgba(0, 0, 0, 0)']).toContain(panel)
      await expect(shell).toHaveCSS('color', rgb(themeColour(id, mode, 'ink')))
    })
  }
}

test('Score itself keeps the prototype’s dark and light sets', async ({ page }) => {
  await pair(page)
  await wearBuiltin(page, 'score', 'dark')
  await page.goto('/b/team')
  const shell = page.locator('[data-ui="bold"]')
  await expect(shell).toHaveCSS('background-color', 'rgb(18, 19, 26)')
})

test('safe mode and the reset shortcut work on the new shell', async ({ page }) => {
  await pair(page)
  await wearBuiltin(page, 'harbour', 'dark')
  await page.goto('/b/team')
  const shell = page.locator('[data-ui="bold"]')
  await expect(page.locator('html')).toHaveAttribute('data-look', 'custom')
  await expect(shell).toHaveCSS('background-color', rgb(themeColour('harbour', 'dark', 'ground')))

  await page.goto('/b/team?look=safe')
  await expect(page.locator('html')).not.toHaveAttribute('data-look', 'custom')
  await expect(shell).toHaveCSS('background-color', 'rgb(18, 19, 26)')
  const banner = page.getByRole('status').filter({ hasText: 'Safe look' })
  await expect(banner).toBeVisible()
  // The way back from the banner leads to the new look's own Settings › Look.
  await banner.getByRole('link', { name: 'Settings › Look' }).click()
  await expect(page).toHaveURL(/\/b\/settings\/look/)
  await expect(page.getByRole('heading', { name: 'Look', exact: true })).toBeVisible()

  await page.goto('/b/team')
  await expect(page.locator('html')).toHaveAttribute('data-look', 'custom')
  await page.keyboard.press('Control+Shift+Digit0')
  await expect(page.locator('html')).not.toHaveAttribute('data-look', 'custom')
  await expect(shell).toHaveCSS('background-color', 'rgb(18, 19, 26)')
})

test('the Customizer previews the new look’s screens in the chosen colours', async ({ page }) => {
  await pair(page)
  await page.goto('/settings/look/customize')
  await expect(page.getByRole('heading', { name: 'Customize' })).toBeVisible()
  const picker = page.getByLabel('Page to preview')
  const frame = page.frameLocator('iframe[title="Preview of your theme"]')
  const hostBody = page.locator('body')

  await picker.selectOption({ label: 'New look: Team' })
  await expect(frame.getByRole('heading', { name: 'Your team', level: 1 })).toBeVisible({
    timeout: 30_000,
  })
  const shell = frame.locator('[data-ui="bold"]')
  await page.getByRole('radio', { name: 'Light', exact: true }).click()
  await expect(shell).toHaveAttribute('data-look', 'light')
  await page.getByRole('radio', { name: 'Dark', exact: true }).click()
  await expect(shell).toHaveAttribute('data-look', 'dark')

  await picker.selectOption({ label: 'New look: Room' })
  await expect(
    frame.locator('[data-ui="bold"] .bold-sidecol, [data-ui="bold"] .side').first(),
  ).toBeVisible({
    timeout: 30_000,
  })
  // The room fits its own frame; the Customizer page around it is untouched.
  await expect(hostBody).not.toHaveClass(/fit/)

  await picker.selectOption({ label: 'New look: Agent page' })
  await expect(frame.locator('[data-ui="bold"] h1').first()).toBeVisible({ timeout: 30_000 })
  await picker.selectOption({ label: 'New look: Settings' })
  await expect(frame.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible({
    timeout: 30_000,
  })
})
