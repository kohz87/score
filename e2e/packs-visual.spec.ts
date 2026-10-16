import { expect, test, type Page } from '@playwright/test'
import { fixtureNow } from './now-fixture.ts'
import { visualFixtures, visualHello } from './visual-fixtures.ts'

// Theme packs (PLAN 8.3): each non-default pack has baselines in light, dark and at phone width for Now, Chat,
// Knowledge and Settings. The default pack's looks are the existing baselines in visual.spec.ts.
const pages = [
  { name: 'now', path: '/now', ready: '.now-cards' },
  { name: 'chat', path: '/chat/room-activity-feed', ready: '.chat-files' },
  { name: 'knowledge', path: '/knowledge/projects/launch-plan.md', ready: '.cm-editor' },
  { name: 'settings', path: '/settings', ready: '.rules-columns' },
]
const packs = [
  { id: 'paper', layout: 'top', density: 'comfortable' },
  { id: 'night', layout: 'side', density: 'comfortable' },
  { id: 'dense', layout: 'side', density: 'compact' },
] as const
const variants = [
  { name: 'light', mode: 'light', width: 1440 },
  { name: 'dark', mode: 'dark', width: 1440 },
  { name: 'phone', mode: 'light', width: 390 },
] as const

test.use({ timezoneId: 'UTC', locale: 'en-GB' })

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date(fixtureNow))
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/stream') {
      await route.fulfill({
        contentType: 'text/event-stream',
        body: `event: stream.hello\ndata: ${JSON.stringify(visualHello)}\n\n`,
      })
      return
    }
    url.searchParams.delete('tz')
    const key = `${url.pathname}${url.search}`
    const fixture = visualFixtures[key]
    expect(fixture, `Missing visual fixture: ${key}`).toBeDefined()
    await route.fulfill({ json: fixture })
  })
})

async function open(page: Page, target: (typeof pages)[number], width: number) {
  await page.setViewportSize({ width, height: 1100 })
  await page.goto(target.path)
  if (target.name === 'chat' && width < 1100)
    await page.getByRole('button', { name: 'Show room details' }).click()
  await expect(page.locator(target.ready).first()).toBeVisible()
  await expect(page.getByText(/^Loading/)).toHaveCount(0)
  await page.evaluate(() => document.fonts.ready)
  await expect(page.locator('html[data-motion]')).toHaveCount(0)
}

for (const pack of packs) {
  for (const variant of variants) {
    test.describe(`${pack.id} pack, ${variant.name}`, () => {
      test.beforeEach(async ({ page }) => {
        await page.addInitScript(
          ([look, mode]) => {
            window.localStorage.setItem('score.look', look!)
            window.localStorage.setItem('score.theme', mode!)
          },
          [
            JSON.stringify({ pack: pack.id, layout: pack.layout, density: pack.density }),
            variant.mode,
          ],
        )
      })
      for (const target of pages) {
        test(`${target.name}`, async ({ page }) => {
          await open(page, target, variant.width)
          const html = page.locator('html')
          await expect(html).toHaveAttribute('data-pack', pack.id)
          await expect(html).toHaveAttribute('data-layout', pack.layout)
          await expect(html).toHaveAttribute('data-density', pack.density)
          await expect(html).toHaveAttribute('data-theme', variant.mode)
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
          ).toBeLessThanOrEqual(1)
          await expect(page).toHaveScreenshot(`${pack.id}-${target.name}-${variant.name}.png`, {
            fullPage: true,
            animations: 'disabled',
            maxDiffPixelRatio: 0.005,
          })
        })
      }
    })
  }
}
