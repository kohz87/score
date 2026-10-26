import { expect, test, type Page } from '@playwright/test'
import { pair } from './pair.ts'

// PLAN 11.3a: the bold shell's frame at a desktop and a phone width, the per-device switch, and reduced motion.

async function addLivedotProbe(page: Page) {
  await page.locator('[data-ui="bold"]').evaluate((root) => {
    const probe = document.createElement('span')
    probe.className = 'livedot'
    probe.dataset.motionProbe = 'true'
    root.append(probe)
  })
  return page.locator('[data-motion-probe="true"]')
}

test('?ui=bold opens the frame at 1440×900 and 390×844', async ({ page }) => {
  await pair(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/?ui=bold')
  await expect(page).toHaveURL('/b')
  await expect(page.getByRole('banner')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Score, go to the team room' })).toBeVisible()
  const topNav = page.getByRole('navigation', { name: 'Main' })
  await expect(topNav.getByRole('button', { name: 'Room' })).toBeVisible()
  await expect(topNav.getByRole('button', { name: 'Team' })).toBeVisible()
  const dock = page.getByRole('group', { name: /Your team/ })
  await expect(dock.getByRole('button', { name: /One to one with lead/ })).toBeVisible()
  await expect(dock.getByRole('button', { name: /One to one with builder/ })).toBeVisible()
  await expect(page.getByRole('complementary', { name: 'Side panel' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Settings' })).toBeVisible()

  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByRole('complementary', { name: 'Side panel' })).toHaveCount(0)
  await expect(page.getByRole('group', { name: /Your team/ })).toHaveCount(0)
  const tabs = page.getByRole('navigation', { name: 'Main' })
  for (const label of ['Room', 'Team', 'Search', 'Settings'])
    await expect(tabs.getByRole('button', { name: label })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Score, go to the team room' })).toBeVisible()
  await expect(page.getByText('Y', { exact: true })).toBeVisible()
})

test('the root and the old ?ui=classic address open the new shell, with no way back to a classic view', async ({
  page,
}) => {
  await pair(page)
  await page.goto('/?ui=classic')
  await expect(page).toHaveURL(/\/b(\?|$)/)
  await page.goto('/b/settings')
  await expect(page.getByRole('button', { name: 'Use the classic view' })).toHaveCount(0)
  await page.goto('/chat')
  await expect(page).toHaveURL(/\/b$/)
  await expect(page.getByRole('button', { name: 'Score, go to the team room' })).toBeVisible()
})

test.describe('reduced motion', () => {
  test.use({ reducedMotion: 'reduce', viewport: { width: 1440, height: 900 } })

  test('no element in the frame keeps a running animation', async ({ page }) => {
    await pair(page)
    await page.goto('/?ui=bold')
    await expect(page.getByRole('group', { name: /Your team/ })).toBeVisible()
    const probe = await addLivedotProbe(page)
    expect(await probe.evaluate((element) => getComputedStyle(element).animationName)).toBe('none')
    const running = await page.locator('[data-ui="bold"]').evaluate((root) =>
      root
        .getAnimations({ subtree: true })
        .filter((animation) => animation.playState === 'running')
        .map((animation) => (animation as CSSAnimation).animationName ?? 'transition'),
    )
    expect(running).toEqual([])
  })
})

test.describe('normal motion', () => {
  test.use({ reducedMotion: 'no-preference', viewport: { width: 1440, height: 900 } })

  test('the livedot animation runs without a reduced-motion preference', async ({ page }) => {
    await pair(page)
    await page.goto('/?ui=bold')
    await expect(page.getByRole('group', { name: /Your team/ })).toBeVisible()
    const probe = await addLivedotProbe(page)
    expect(await probe.evaluate((element) => getComputedStyle(element).animationName)).not.toBe(
      'none',
    )
  })
})
