import { expect, test, type Locator, type Page } from '@playwright/test'
import { appendFileSync } from 'node:fs'

// Render budget and the longest main-thread task allowed while the load generator is running.
const RENDER_BUDGET_MS = 2000
const LONG_TASK_BUDGET_MS = 200
const WATCH_MS = 5000

test.use({ viewport: { width: 1440, height: 1100 } })

async function pair(page: Page) {
  const base = new URL(process.env.PERF_BASE_URL!)
  await page.context().addCookies([
    {
      name: process.env.PERF_COOKIE_NAME!,
      value: process.env.PERF_COOKIE_VALUE!,
      domain: base.hostname,
      path: '/',
    },
  ])
}

async function measure(page: Page, label: string, path: string, ready: (page: Page) => Locator) {
  await page.addInitScript(() => {
    const w = window as unknown as { __long: [number, number][] }
    w.__long = [] // [startTime, duration]
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) w.__long.push([entry.startTime, entry.duration])
    }).observe({ type: 'longtask', buffered: true } as PerformanceObserverInit)
  })
  await page.goto(path, { waitUntil: 'commit' })
  await ready(page).first().waitFor({ state: 'visible', timeout: 15_000 })
  // performance.now() counts from the navigation start of this document.
  const renderMs = await page.evaluate(() => performance.now())
  await page.waitForTimeout(WATCH_MS)
  // Boot work before the page is ready is covered by the render budget; responsiveness is judged on
  // the main-thread tasks that start after it, while live events keep arriving.
  const all = await page.evaluate(
    () => (window as unknown as { __long: [number, number][] }).__long,
  )
  const long = all.filter(([start]) => start >= renderMs).map(([, duration]) => duration)
  const result = {
    label: process.env.PERF_LABEL ?? '',
    route: label,
    renderMs: Math.round(renderMs),
    longTasks: long.length,
    maxLongTaskMs: Math.round(Math.max(0, ...long)),
  }
  appendFileSync(process.env.PERF_OUT!, `${JSON.stringify(result)}\n`)
  expect(result.renderMs, `${label} render time`).toBeLessThan(RENDER_BUDGET_MS)
  expect(result.maxLongTaskMs, `${label} longest task`).toBeLessThan(LONG_TASK_BUDGET_MS)
}

test('Score view', async ({ page }) => {
  await pair(page)
  await measure(page, '/now', '/now', (p) => p.getByRole('region', { name: /^Score:/ }))
})

test('Chat room', async ({ page }) => {
  await pair(page)
  await measure(page, '/chat/room-load-0', '/chat/room-load-0', (p) =>
    p.getByRole('region', { name: 'Message history' }).getByRole('article'),
  )
})

test('Flow', async ({ page }) => {
  await pair(page)
  await measure(page, '/now/flow', '/now/flow', (p) => p.locator('[data-flow-node]'))
})
