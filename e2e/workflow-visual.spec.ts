import { expect, test, type Page } from '@playwright/test'
import { fixtureNow } from './now-fixture.ts'
import { okValidation, unfinishedValidation, workflowFixtures } from './workflow-fixtures.ts'
import { visualFixtures, visualHello } from './visual-fixtures.ts'

// Baselines for the workflow pages (PLAN 7.1b), from frozen fixtures: a run caught with its gate waiting for the person,
// and the room's run panel. The list and the editor became the Recipes page (2.8.0; e2e/bold-classic-pages.spec.ts).

test.use({ timezoneId: 'UTC', locale: 'en-GB' })

test.beforeEach(async ({ page }) => {
  // The classic view: the bold shell frames these pages since 2.0.2 (e2e/bold-classic-pages.spec.ts).
  await page.addInitScript(() => window.localStorage.setItem('score.ui', 'classic'))
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
    if (url.pathname === '/api/workflows/validate') {
      const body = JSON.parse(route.request().postData() ?? '{}') as {
        definition?: { name?: string }
      }
      await route.fulfill({
        json: body.definition?.name?.includes('(draft)') ? unfinishedValidation : okValidation,
      })
      return
    }
    url.searchParams.delete('tz')
    const key = `${url.pathname}${url.search}`
    const fixture = { ...visualFixtures, ...workflowFixtures }[key]
    if (fixture === undefined) {
      await route.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'none' } } })
      return
    }
    await route.fulfill({ json: fixture })
  })
})

const pages = [
  {
    name: 'workflow-run',
    path: '/runs/brief-wfrun-1',
    ready: '[data-node="approve"]',
    widths: [1440, 768, 390],
  },
  {
    name: 'workflow-room',
    path: '/chat/room-activity-feed',
    ready: '.wf-room-run .orch-room-body',
    widths: [1440, 390],
  },
] as const

async function open(page: Page, target: (typeof pages)[number], width: number, dark = false) {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  if (dark) await page.addInitScript(() => window.localStorage.setItem('score.theme', 'dark'))
  await page.setViewportSize({ width, height: 1100 })
  await page.goto(target.path)
  await expect(page.locator(target.ready).first()).toBeVisible()
  await expect(page.getByText(/^Loading/)).toHaveCount(0)
  await page.evaluate(() => document.fonts.ready)
  await page.evaluate(() => {
    const scroll = document.querySelector('.chat-scroll')
    if (scroll) scroll.scrollTop = 0
  })
}

for (const target of pages) {
  const variants: [number, boolean][] = [
    ...target.widths.map((w): [number, boolean] => [w, false]),
    [1440, true],
  ]
  for (const [width, dark] of variants) {
    const name = `${target.name}${dark ? '-dark' : ''}-${width}.png`
    test(`${target.name} at ${width}px${dark ? ' dark' : ''}`, async ({ page }) => {
      await open(page, target, width, dark)
      if (width <= 768)
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
