import { expect, test } from '@playwright/test'
import { mockBoldRoom } from './bold-room-fixtures.ts'
import { at, sizes } from './bold-thread-helpers.ts'
import { pair } from './pair.ts'

test.use({ reducedMotion: 'reduce' })

for (const viewport of sizes) {
  const size = `${viewport.width}×${viewport.height}`
  test.describe(size, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize(viewport)
    })

    test(`the general conversation's context bar uses the room session at ${size}`, async ({
      page,
    }) => {
      await pair(page)
      await mockBoldRoom(page)
      const asked: string[] = []
      await page.route('**/api/agents/lead/sessions/**', async (route) => {
        asked.push(new URL(route.request().url()).pathname)
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            asOfSeq: 12,
            window: 100000,
            used: 10000,
            measuredAt: at(7),
            model: 'demo-model',
            source: 'provider_usage',
            parts: null,
            autoCompactAt: null,
            compactions: 0,
          }),
        })
      })
      await page.goto('/b?job=job-default')
      await expect(page.locator('[data-ui="bold"] .top .word')).toBeVisible({ timeout: 20_000 })
      // 3.22.0: the meter is in the context bar under the composer (the thread panel's ring is gone; /compress is its
      // Compact). It reads the session the message lands in: the room session for the general conversation.
      const meter = page
        .locator('.bold-context-bar')
        .getByRole('button', { name: /^lead context: 10 % of 100k/ })
      await expect(meter).toBeVisible()
      await expect(meter).toContainText('10%')
      expect(asked.length).toBeGreaterThan(0)
      expect(
        asked.every((path) => path === '/api/agents/lead/sessions/score-team-room-lead/context'),
      ).toBe(true)
    })
  })
}
