import { expect, test, type Page } from '@playwright/test'
import { pair } from './pair.ts'

// 3.0.0: the classic chat-follow spec on the new shell's team room. The seeded team room is long enough to scroll in a
// short window. Nothing here posts, so it can share the seeded room with every other spec.
test.use({ reducedMotion: 'reduce', viewport: { width: 1440, height: 640 } })

const distance = (page: Page) =>
  page
    .locator('#bold-room-stream')
    .evaluate((el) => Math.round(el.scrollHeight - el.scrollTop - el.clientHeight))

async function openSettled(page: Page) {
  await pair(page)
  await page.goto('/b')
  const stream = page.locator('#bold-room-stream')
  await expect(stream.getByRole('article').first()).toBeAttached({ timeout: 30_000 })
  await expect
    .poll(() => stream.evaluate((el) => el.scrollHeight > el.clientHeight), { timeout: 15_000 })
    .toBe(true)
}

test('the opened room settles with the thread at its end', async ({ page }) => {
  await openSettled(page)
  await expect.poll(() => distance(page)).toBeLessThanOrEqual(1)
})

test('the thread stays at its end when a message grows and the layout flips inside one frame', async ({
  page,
}) => {
  await openSettled(page)
  await expect.poll(() => distance(page)).toBeLessThanOrEqual(1)
  // A message grows (a late font, a code block highlighting): the thread follows. Straight after that, before the next
  // frame dispatches the scroll event the follow queued, the composer shrinks and grows back with a forced layout in
  // between (the thread is clamped up the page) and ends at the size it had, so no further resize is announced.
  await page.evaluate(
    () =>
      new Promise<void>((done) => {
        const scroll = document.querySelector<HTMLElement>('#bold-room-stream')!
        const composer = document.querySelector<HTMLElement>('.bold-room-composer')!
        const messages = scroll.querySelector<HTMLElement>('.bold-stream')!
        let flipped = false
        const probe = new MutationObserver(() => {
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
        probe.observe(messages, { childList: true })
        const growth = document.createElement('div')
        growth.style.height = '60px'
        messages.append(growth)
      }),
  )
  await expect.poll(() => distance(page)).toBeLessThanOrEqual(1)
})

test('a reader who scrolled up is left where they are when a message grows', async ({ page }) => {
  await openSettled(page)
  await expect.poll(() => distance(page)).toBeLessThanOrEqual(1)
  await page.locator('#bold-room-stream').evaluate((el) => {
    el.scrollTop = 0
  })
  await expect.poll(() => distance(page)).toBeGreaterThan(200)
  // The scroll event that tells the thread the reader left the end is dispatched on the next frame.
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
  )
  await page.evaluate(() => {
    const messages = document.querySelector<HTMLElement>('#bold-room-stream .bold-stream')!
    const growth = document.createElement('div')
    growth.style.height = '60px'
    messages.append(growth)
  })
  await page.waitForTimeout(300)
  expect(await page.locator('#bold-room-stream').evaluate((el) => el.scrollTop)).toBeLessThan(5)
})

test('scrolling up during a streaming reply stays put', async ({ page }) => {
  await openSettled(page)
  await expect.poll(() => distance(page)).toBeLessThanOrEqual(1)
  // A wheel up and, in the same task, text arriving: the observer must not snap the reader back.
  const top = await page.evaluate(async () => {
    const scroll = document.querySelector<HTMLElement>('#bold-room-stream')!
    const messages = scroll.querySelector<HTMLElement>('.bold-stream')!
    scroll.scrollTop = Math.max(0, scroll.scrollTop - 300)
    const at = scroll.scrollTop
    for (let i = 0; i < 5; i++) {
      const line = document.createElement('p')
      line.textContent = `streamed ${i}`
      messages.append(line)
      await new Promise((done) => setTimeout(done, 30))
    }
    return [at, scroll.scrollTop]
  })
  expect(top[1]).toBeLessThanOrEqual(top[0]! + 2)
  expect(await distance(page)).toBeGreaterThan(100)
})
