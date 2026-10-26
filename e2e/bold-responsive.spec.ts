import { expect, test, type Page } from '@playwright/test'
import { pair } from './pair.ts'

// Ported from responsive.spec.ts (PLAN 5.34): phone (< 600px) and tablet (600-1023px) on the new shell. No page may
// scroll sideways at any width. The old hamburger drawer, the Chat room-list drawer and the Settings disclosure are
// gone with the classic layout; the phone tab bar and sheets are covered by bold-phone.spec.ts.
test.use({ reducedMotion: 'reduce' })

const routes = [
  { name: 'room', path: '/b', ready: '[data-ui="bold"] .top .word' },
  { name: 'team', path: '/b/team', ready: '.bold-agentcard' },
  { name: 'agent', path: '/b/team/builder', ready: '.bold-agent' },
  { name: 'library', path: '/b?library=1', ready: '[data-ui="bold"] .top .word' },
  { name: 'runs', path: '/b/recipes', ready: '[data-ui="bold"] .top .word' },
  { name: 'settings', path: '/b/settings', ready: '.bold-settings-page' },
  {
    name: 'usage',
    path: '/b/settings/usage',
    ready: '.usage-stats, [aria-label="Usage in numbers"]',
  },
  { name: 'journey', path: '/b/settings/usage?tab=journey', ready: '.journey__row' },
  { name: 'screen', path: '/b/screen/builder', ready: '.bold-screen-badge' },
] as const

async function open(page: Page, where: (typeof routes)[number], width: number) {
  await page.setViewportSize({ width, height: width < 600 ? 844 : 1024 })
  await page.goto(where.path)
  await expect(page.locator(where.ready).first()).toBeVisible()
  await expect(page.getByText(/^Loading/).filter({ visible: true })).toHaveCount(0, {
    timeout: 15_000,
  })
  await page.evaluate(() => document.fonts.ready)
}

for (const width of [360, 390, 768, 1023]) {
  test(`no route scrolls sideways at ${width}px`, async ({ page }) => {
    await pair(page)
    for (const where of routes) {
      await open(page, where, width)
      const extra = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      )
      expect(extra, `${where.name} at ${width}px`).toBeLessThanOrEqual(1)
    }
  })
}
