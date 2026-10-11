import { expect, test } from '@playwright/test'
import { pair } from './pair.ts'

// A reply whose run goes quiet says so after 60 s (the fake adapter's "go quiet" hook), and Stop still works.
test('a silent reply shows the waiting notice next to Stop, and stopping ends it', async ({
  page,
}) => {
  test.setTimeout(90_000)
  await pair(page)
  await page.goto('/chat')
  await page
    .getByRole('navigation', { name: 'Rooms' })
    .getByRole('link', { name: /#activity-feed/ })
    .click({ timeout: 15_000 })
  const history = page.getByRole('region', { name: 'Message history' })
  await expect(history.getByRole('article').first()).toBeVisible({ timeout: 15_000 })
  const composer = page.getByRole('combobox', { name: /^Message/ })
  // After pairing: the clock only fakes this page's timers from here on.
  await page.clock.install()
  const text = `Please go quiet ${Date.now()}`
  await composer.fill(text)
  await composer.press('Enter')
  // The scenario's own demo reply ("Let’s add pagination…") streams forever in fake mode; ours is the empty one.
  const reply = history.getByRole('article').filter({
    has: page.getByRole('button', { name: /^Stop reply from/ }),
    hasNotText: /pagination/,
  })
  const stop = reply.getByRole('button', { name: /^Stop reply from/ })
  await expect(stop).toBeVisible({ timeout: 20_000 })
  const notice = reply.getByText(/Waiting for the model/)
  await expect(notice).toHaveCount(0)
  await page.clock.fastForward(65_000)
  await expect(notice).toBeVisible()
  await expect(notice).toContainText(
    'Hermes may be retrying after a rate limit or a provider error',
  )
  await page.clock.fastForward(30_000)
  await expect(notice).toContainText('1 min 30 s')
  const id = await reply.getAttribute('id')
  await stop.click()
  const stopped = page.locator(`[id="${id}"]`)
  await expect(stopped).toContainText('This run was stopped.', { timeout: 20_000 })
  await expect(stopped.getByText(/Waiting for the model/)).toHaveCount(0)
})
