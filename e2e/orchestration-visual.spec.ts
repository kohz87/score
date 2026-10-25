import { expect, test, type Page } from '@playwright/test'
import { fixtureNow } from './now-fixture.ts'
import { orchestrationFixtures } from './orchestration-fixtures.ts'
import { visualFixtures, visualHello } from './visual-fixtures.ts'

// Baselines for the orchestration pages (PLAN 7.5b), from frozen fixtures: the room view and the live diagram mid-run,
// light, dark and 390 px. The run is caught with one step done, one running and one waiting for the person.

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
    const fixture = { ...visualFixtures, ...orchestrationFixtures }[key]
    if (fixture === undefined) {
      // The generic Flow of the run's brief is not used by the orchestration view.
      await route.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'none' } } })
      return
    }
    await route.fulfill({ json: fixture })
  })
})

const pages = [
  {
    name: 'orchestration-room',
    path: '/chat/room-activity-feed',
    ready: '.orch-room-body .orch-step',
  },
  { name: 'orchestration-live', path: '/runs/brief-orch-1', ready: '[data-node="s2"]' },
]

async function open(page: Page, target: (typeof pages)[number], width: number, dark = false) {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  if (dark) await page.addInitScript(() => window.localStorage.setItem('score.theme', 'dark'))
  await page.setViewportSize({ width, height: 1100 })
  await page.goto(target.path)
  await expect(page.locator(target.ready).first()).toBeVisible()
  await expect(page.getByText(/^Loading/)).toHaveCount(0)
  await page.evaluate(() => document.fonts.ready)
  // The thread pins itself to the newest message; the baseline shows the panel from its top.
  await page.evaluate(() => {
    const scroll = document.querySelector('.chat-scroll')
    if (scroll) scroll.scrollTop = 0
  })
}

for (const target of pages) {
  for (const [width, dark] of [
    [1440, false],
    [1440, true],
    [390, false],
  ] as const) {
    const name = `${target.name}${dark ? '-dark' : ''}-${width}.png`
    test(`${target.name} at ${width}px${dark ? ' dark' : ''}`, async ({ page }) => {
      await open(page, target, width, dark)
      if (width === 390)
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
        ).toBeLessThanOrEqual(1)
      await expect(page).toHaveScreenshot(name, {
        fullPage: true,
        animations: 'disabled',
        maxDiffPixelRatio: 0.005,
      })
    })
  }
}
