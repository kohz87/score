import { expect, test, type Page } from '@playwright/test'
import { pair } from './pair.ts'

// 3.0.0: the update banner is in the frame's flow, under the top bar, so it never covers anything.
test.use({ reducedMotion: 'reduce' })

async function withBanner(page: Page) {
  await pair(page)
  await page.goto('/b')
  await expect(page.locator('.bold-room-composer')).toBeVisible({ timeout: 30_000 })
  await page.evaluate(() => {
    const banner = document.createElement('div')
    banner.className = 'update-banner'
    banner.setAttribute('role', 'status')
    banner.textContent = 'Update available'
    document.querySelector('main.main')!.prepend(banner)
  })
  return page.locator('.update-banner')
}

for (const [name, viewport] of [
  ['desktop', { width: 1440, height: 900 }],
  ['phone', { width: 390, height: 844 }],
] as const) {
  test(`the update banner takes its own room: it covers neither the top bar, the composer, the tab bar nor a protected surface at ${name}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport)
    const banner = await withBanner(page)
    await expect(banner).toBeVisible()
    const clash = await page.evaluate(() => {
      const box = document.querySelector('.update-banner')!.getBoundingClientRect()
      const hit = (selector: string) =>
        [...document.querySelectorAll(selector)].some((el) => {
          const r = el.getBoundingClientRect()
          return (
            r.width > 0 &&
            r.height > 0 &&
            box.left < r.right &&
            box.right > r.left &&
            box.top < r.bottom &&
            box.bottom > r.top
          )
        })
      return {
        composer: hit('.bold-room-composer, .bold-dm-composer'),
        tabbar: hit('.bold-tabbar'),
        protectedSurface: hit('[data-protected]'),
        top: box.top,
        topBarBottom: document.querySelector('header.top')!.getBoundingClientRect().bottom,
      }
    })
    expect(clash.composer).toBe(false)
    expect(clash.tabbar).toBe(false)
    expect(clash.protectedSurface).toBe(false)
    expect(clash.top).toBeGreaterThanOrEqual(clash.topBarBottom - 1)
  })
}
