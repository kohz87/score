import { expect, test, type Page } from '@playwright/test'
import { pair } from './pair.ts'

/** The step list shows the five newest; older steps sit behind "Full history" (the shared server may hold more). */
async function fullHistory(page: Page) {
  const steps = page.getByRole('region', { name: 'What builder did' })
  // Wait for the list itself, then open the history only when there is more than the newest few.
  await steps.getByRole('listitem').first().waitFor()
  const more = steps.getByRole('button', { name: 'Full history' })
  if (await more.count()) await more.click()
}

// 2.6.0: Watch is the replay on the agent's screen page (board D) on the seeded fake team.

test.use({ reducedMotion: 'reduce' })

const sizes = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'phone', width: 390, height: 844 },
] as const

for (const size of sizes) {
  test.describe(size.name, () => {
    test.beforeEach(async ({ page, context }) => {
      await context.grantPermissions(['clipboard-read', 'clipboard-write'])
      await pair(page)
      await page.setViewportSize({ width: size.width, height: size.height })
    })

    test(`the old Watch address opens the screen page and keeps its query (${size.name})`, async ({
      page,
    }) => {
      await page.goto('/b/watch/builder?x=1')
      await expect(page).toHaveURL(/\/b\/screen\/builder\?x=1$/)
      await expect(page.getByRole('heading', { name: 'builder’s screen' })).toBeVisible()
      await page.goto('/watch/builder')
      await expect(page).toHaveURL(/\/b\/screen\/builder$/)
    })

    test(`scrub, jump to a step, swap a small frame in, then go live (${size.name})`, async ({
      page,
    }) => {
      await page.goto('/b/screen/builder')
      await expect(page.getByRole('heading', { name: 'builder’s screen' })).toBeVisible()
      // Never a remote desktop: nothing on the page types into the agent.
      await expect(page.locator('input:not([type="range"]), textarea')).toHaveCount(0)
      await expect(page.getByRole('group', { name: 'Other windows' })).toBeVisible()
      await expect(page.locator('.bold-screen-badge', { hasText: 'Live' })).toBeVisible()

      await fullHistory(page)
      await page
        .getByRole('region', { name: 'What builder did' })
        .getByRole('button', { name: /Opened the activity feed/ })
        .click()
      await expect(page.getByText(/^Replaying /)).toBeVisible()
      await page.getByRole('button', { name: 'Back 30 seconds' }).click()
      await expect(page.getByText(/^Replaying /)).toBeVisible()

      const small = page.getByRole('group', { name: 'Other windows' }).getByRole('button').first()
      if (await small.isEnabled()) {
        const name = (await small.getAttribute('aria-label')) ?? ''
        await small.click()
        await expect(
          page.getByRole('group', { name: 'Other windows' }).getByRole('button', { name }),
        ).toHaveCount(0)
      }

      await page.getByRole('button', { name: 'Back to live' }).click()
      await expect(page.locator('.bold-screen-badge', { hasText: 'Live' })).toBeVisible()
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
      ).toBeLessThanOrEqual(1)
    })

    test(`pause, copy the resume command and open another screen (${size.name})`, async ({
      page,
    }) => {
      await page.goto('/b/screen/builder')
      await page.getByRole('button', { name: 'Pause builder' }).click()
      await expect(page.getByRole('button', { name: 'Resume builder' })).toBeVisible()
      await page.getByRole('button', { name: 'Resume builder' }).click()
      await expect(page.getByRole('button', { name: 'Pause builder' })).toBeVisible()

      await page.getByRole('button', { name: /Copy the command to continue/ }).click()
      await expect(page.getByRole('status').filter({ hasText: 'hermes -p builder' })).toBeVisible()

      const chips = page.getByRole('navigation', { name: 'Other screens' }).getByRole('link')
      await expect(chips.first()).toBeVisible()
      await chips.first().click()
      await expect(page).toHaveURL(/\/b\/screen\/(?!builder$)[^/]+$/)
    })
  })
}
