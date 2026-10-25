import { expect, test } from '@playwright/test'
import { holdLockPerTest } from './locks.ts'
import { pair } from './pair.ts'

// PLAN 2.0.12: a long More card folds its list and expands in place.
test.use({ reducedMotion: 'reduce' })
holdLockPerTest('roster')

const sizes = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
] as const

for (const viewport of sizes) {
  test(`Remembers folds past six memories and expands at ${viewport.width}×${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport)
    await pair(page)
    const items = Array.from({ length: 14 }, (_, i) => ({
      id: `m${i}`,
      text: `Remembered fact number ${i + 1}`,
      source: 'you',
      at: '2026-10-24T10:00:00.000Z',
    }))
    await page.route('**/api/agents/builder/memory*', async (route) => {
      if (route.request().method() !== 'GET') return route.fallback()
      await route.fulfill({ json: { items, nextCursor: null } })
    })
    await page.goto('/b/team/builder')
    await page
      .getByRole('button', {
        name: 'More: memory, skills, tools, workspace, repeating jobs, delete',
      })
      .click()
    const card = page.locator('#agent-memory')
    await expect(card.locator('.listrow')).toHaveCount(6)
    await expect(card.getByLabel('New memory')).toBeVisible()
    const button = card.getByRole('button', { name: 'Show all 14' })
    await expect(button).toHaveAttribute('aria-expanded', 'false')
    await button.click()
    await expect(card.locator('.listrow')).toHaveCount(14)
    await expect(card.getByRole('button', { name: 'Show less' })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow).toBeLessThanOrEqual(0)
    await card.getByRole('button', { name: 'Show less' }).click()
    await expect(card.locator('.listrow')).toHaveCount(6)
  })
}
