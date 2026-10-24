import { expect, test, type Page } from '@playwright/test'
import { pair } from './pair.ts'

// PLAN 11.5: the seeded team room's Results at the two review sizes, with reduced motion. The fake demo moves on over
// time, so the assertions use the seeded jobs' stable content rather than transient status or timestamps.

const sizes = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'phone', width: 390, height: 844 },
] as const

async function openResults(page: Page, size: (typeof sizes)[number]) {
  await page.setViewportSize({ width: size.width, height: size.height })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/b')
  await expect(page.locator('[data-ui="bold"]')).toBeVisible()
  if (size.width < 861) await page.getByRole('button', { name: 'Open side panel' }).click()

  const panel = page.getByRole('complementary', { name: 'Side panel' })
  await expect(panel).toBeVisible()
  await expect(panel.getByRole('tab', { name: 'Results' })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await expect(panel.getByTestId('bold-results')).toBeVisible()
  return panel
}

for (const size of sizes) {
  test.describe(size.name, () => {
    test('shows the seeded change, live preview, draft and screens without raw code', async ({
      page,
    }) => {
      await pair(page)
      const panel = await openResults(page, size)

      const change = panel.locator('[data-card="change"]').filter({ hasText: 'Activity feed' })
      await expect(change).toContainText('What changed')
      await expect(change).toContainText('Activity feed')
      await expect(change).toContainText('Events in the same millisecond get skipped.')
      await expect(change).toContainText('reviewer caught this')
      await expect(change).not.toContainText('api/events.py')
      await expect(change.getByRole('link', { name: 'See the code · 2 files' })).toHaveAttribute(
        'href',
        /^\/b\?job=.+&work=code$/,
      )

      const preview = panel.locator('[data-card="preview"]')
      await expect(preview.getByRole('heading', { name: 'Activity feed' })).toBeVisible()
      await expect(preview).toContainText('Live preview')
      await expect(preview).toContainText('http://localhost:5173/feed')
      await expect(preview).toHaveAttribute('href', /^\/b\?job=.+&work=screen$/)

      const draft = panel
        .locator('[data-card="draft"]')
        .filter({ hasText: 'Announcement image.md' })
      await expect(draft.getByRole('heading', { name: 'Announcement image.md' })).toBeVisible()
      await expect(draft).toContainText('Release notes 2.4')
      await expect(draft).toContainText('Saved to the Library')
      await expect(draft.getByRole('link', { name: 'Open the draft' })).toHaveAttribute(
        'href',
        /^\/b\?job=.+&work=draft$/,
      )

      const screens = panel.getByRole('region', { name: 'Screens' })
      await expect(screens.getByRole('link', { name: 'Watch builder’s screen' })).toBeVisible()
      await expect(screens).toContainText('builder')
      await expect(screens.getByRole('link', { name: 'Watch builder’s screen' })).toHaveAttribute(
        'href',
        /^\/b\?job=.+&work=screen$/,
      )

      const running = await panel.getByTestId('bold-results').evaluate((root) =>
        root
          .getAnimations({ subtree: true })
          .filter((animation) => animation.playState === 'running')
          .map((animation) => (animation as CSSAnimation).animationName ?? 'transition'),
      )
      expect(running).toEqual([])

      if (size.width < 861) {
        const box = await panel.boundingBox()
        expect(box).not.toBeNull()
        expect(box!.x).toBeGreaterThanOrEqual(0)
        expect(box!.x + box!.width).toBeLessThanOrEqual(size.width + 0.5)
      }
    })
  })
}
