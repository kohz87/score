import { expect, test, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Runs against its own fake-adapter server with SCORE_KANBAN_ATTEMPTS=1 and seeded attempts (playwright.config.ts;
// seed: apps/server/src/hermes/fake/attempts-seed.ts). Every other spec runs with the flag off.
test.describe.configure({ mode: 'serial' })
test.use({ viewport: { width: 1440, height: 1100 }, timezoneId: 'UTC', locale: 'en-GB' })

let page: Page
test.beforeAll(async ({ browser, baseURL }) => {
  const context = await browser.newContext({
    baseURL: baseURL!,
    viewport: { width: 1440, height: 1100 },
    timezoneId: 'UTC',
    locale: 'en-GB',
  })
  page = await context.newPage()
  const log = join(process.env.SCORE_E2E_HOME!, 'attempts.log')
  await expect
    .poll(() => /\/pair#([\w-]+)/.exec(readFileSync(log, 'utf8'))?.[1], { timeout: 30_000 })
    .toBeTruthy()
  const token = /\/pair#([\w-]+)/.exec(readFileSync(log, 'utf8'))![1]
  await page.goto(`/pair#${token}`)
  await expect(page.getByText('This browser is paired')).toBeVisible({ timeout: 15_000 })
})
test.afterAll(async () => {
  await page.context().close()
})

test('Reports counts Unknown-agent work and Team history lists the attempts', async () => {
  await page.goto('/reports')
  const table = page.getByRole('table', { name: 'By agent', exact: true })
  await expect(table.locator('tbody th', { hasText: 'Unknown agent' })).toBeVisible()
  await expect(page.getByText(/counts only the runs Score could confirm/)).toBeVisible()
  await page.goto('/team/designer')
  await page.getByRole('tab', { name: 'History' }).click()
  const panel = page.getByRole('tabpanel')
  await expect(panel.locator('.team-channel-state', { hasText: 'Failed' })).toBeVisible()
  await expect(panel.getByRole('link', { name: /Open this run/ })).toBeVisible()
  await expect(panel.getByRole('link', { name: /Replay/ })).toHaveCount(0)
})
