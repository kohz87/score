import { expect, test, type Page } from '@playwright/test'
import { fixtureNow } from './now-fixture.ts'
import { orchestrationFixtures } from './orchestration-fixtures.ts'
import { visualFixtures, visualHello } from './visual-fixtures.ts'

// Baselines for the chat-first user view (PLAN 8.4) from frozen fixtures: the empty state, a conversation, and a run in
// progress (status lines and a Needs-you card in the chat), in the Score pack and in Night shift; light, dark and 390 px.

const pages = [
  { name: 'empty', path: '/u', ready: '.user-empty textarea', runs: false },
  { name: 'room', path: '/u/rooms/room-activity-feed', ready: '.chat-message', runs: false },
  {
    name: 'run',
    path: '/u/rooms/room-activity-feed',
    ready: '.user-needs .orch-decision',
    runs: true,
  },
]
const packs = [
  { id: 'score', look: null },
  { id: 'night', look: { pack: 'night', layout: 'side', density: 'comfortable' } },
] as const
const variants = [
  { name: 'light', mode: 'light', width: 1440 },
  { name: 'dark', mode: 'dark', width: 1440 },
  { name: 'phone', mode: 'light', width: 390 },
] as const

test.use({ timezoneId: 'UTC', locale: 'en-GB' })

async function freeze(page: Page, withRuns: boolean) {
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
    const fixture = (withRuns ? { ...visualFixtures, ...orchestrationFixtures } : visualFixtures)[
      key
    ]
    expect(fixture, `Missing visual fixture: ${key}`).toBeDefined()
    await route.fulfill({ json: fixture })
  })
}

for (const pack of packs) {
  for (const variant of variants) {
    test.describe(`user view, ${pack.id} pack, ${variant.name}`, () => {
      for (const target of pages) {
        test(target.name, async ({ page }) => {
          await freeze(page, target.runs)
          await page.emulateMedia({ reducedMotion: 'reduce' })
          await page.addInitScript(
            ([look, mode]) => {
              if (look) window.localStorage.setItem('score.look', look)
              window.localStorage.setItem('score.theme', mode!)
            },
            [pack.look ? JSON.stringify(pack.look) : null, variant.mode],
          )
          await page.setViewportSize({ width: variant.width, height: 900 })
          await page.goto(target.path)
          await expect(page.locator(target.ready).first()).toBeVisible()
          await expect(page.getByText(/^Loading/)).toHaveCount(0)
          await page.evaluate(() => document.fonts.ready)
          await expect(page.locator('html')).toHaveAttribute('data-pack', pack.id)
          await expect(page.locator('html')).toHaveAttribute('data-theme', variant.mode)
          // The run's baseline shows the end of the thread (its latest lines and the card that needs the person); the
          // other pages show their top.
          await page.evaluate((toEnd) => {
            const scroll = document.querySelector('.chat-scroll')
            if (scroll) scroll.scrollTop = toEnd ? scroll.scrollHeight : 0
          }, target.name === 'run')
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
          ).toBeLessThanOrEqual(1)
          await expect(page).toHaveScreenshot(
            `user-${pack.id}-${target.name}-${variant.name}.png`,
            {
              animations: 'disabled',
              maxDiffPixelRatio: 0.005,
            },
          )
        })
      }
    })
  }
}
