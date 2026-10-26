import { expect, test } from '@playwright/test'
import { pair } from './pair.ts'

// 3.3.0: the live Bot Desktop card on the agent's screen page, against the fake adapter.
test.use({ reducedMotion: 'reduce' })

test('builder shows a live, updating image', async ({ page }) => {
  await pair(page)
  await page.goto('/b/screen/builder')
  const img = page.getByAltText('builder’s screen, live')
  await expect(img).toBeVisible()
  await expect
    .poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth))
    .toBeGreaterThan(0)
  const first = await img.getAttribute('src')
  await expect.poll(() => img.getAttribute('src'), { timeout: 4000 }).not.toBe(first)
})

test('reviewer’s screen is off', async ({ page }) => {
  await pair(page)
  await page.goto('/b/screen/reviewer')
  await expect(page.getByText('The screen is off.')).toBeVisible()
})

test('no horizontal scroll on a phone', async ({ page }) => {
  await pair(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/b/screen/builder')
  await expect(page.getByAltText('builder’s screen, live')).toBeVisible()
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  )
  expect(overflow).toBe(false)
})
