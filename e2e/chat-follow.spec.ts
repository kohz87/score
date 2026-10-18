import { expect, test } from '@playwright/test'
import { chatSettled } from './chat-settled.ts'
import { fixtureNow } from './now-fixture.ts'
import { visualFixtures, visualHello } from './visual-fixtures.ts'

test.use({ timezoneId: 'UTC', locale: 'en-GB', viewport: { width: 390, height: 1100 } })

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
    const fixture = visualFixtures[`${url.pathname}${url.search}`]
    expect(fixture, `Missing visual fixture: ${url.pathname}${url.search}`).toBeDefined()
    await route.fulfill({ json: fixture })
  })
})

const distance = (page: import('@playwright/test').Page) =>
  page
    .locator('.chat-scroll')
    .evaluate((el) => Math.round(el.scrollHeight - el.scrollTop - el.clientHeight))

async function openSettled(page: import('@playwright/test').Page) {
  await page.goto('/chat/room-activity-feed')
  await page.getByRole('button', { name: 'Show room details' }).click()
  await expect(page.locator('.chat-files').first()).toBeVisible()
  await chatSettled(page)
}

test('the opened room settles with the thread at its end once the context ring has arrived', async ({
  page,
}) => {
  // chatSettled() asserts the thread is at its end; here nothing else is waited for first, so the ring's arrival and
  // its flip from the lead to the last replier land while the thread is still following its first scroll.
  await openSettled(page)
})

test('the thread stays at its end when the layout flips inside one frame, just after the thread followed', async ({
  page,
}) => {
  await openSettled(page)
  // A message grows (a late font, a code block highlighting): the thread follows from its ResizeObserver. Straight
  // after that callback, before the next frame dispatches the scroll event the follow queued, the composer shrinks
  // and grows back with a forced layout in between (the thread is clamped up the page by 50px) and ends at the size
  // the observer already reported, so no further resize is announced.
  await page.evaluate(
    () =>
      new Promise<void>((done) => {
        const scroll = document.querySelector<HTMLElement>('.chat-scroll')!
        const composer = document.querySelector<HTMLElement>('[aria-label="Context use"]')!
        const messages = document.querySelector<HTMLElement>('.chat-messages')!
        let flipped = false
        const probe = new ResizeObserver(() => {
          if (flipped) return
          flipped = true
          queueMicrotask(() => {
            composer.style.display = 'none'
            void scroll.scrollHeight // forced layout: the thread is clamped
            composer.style.display = ''
            done()
          })
        })
        // Created after the app's own observer, so it is notified after it within the same step.
        probe.observe(messages)
        const growth = document.createElement('div')
        growth.style.height = '60px'
        messages.append(growth)
      }),
  )
  await expect.poll(() => distance(page)).toBeLessThanOrEqual(1)
})
