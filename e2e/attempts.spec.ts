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

/**
 * The Recent runs card lists the newest few and the scenario starts chat runs for this agent all the time, so the
 * seeded attempt can sit below the fold: open the whole list (whenever the button is there) until its link shows.
 */
async function openRunLink(page: Page) {
  const history = page.locator('#agent-history')
  const open = history.getByRole('link', { name: 'Open run' }).first()
  await expect(async () => {
    const all = history.getByRole('button', { name: 'All runs' })
    if (await all.isVisible()) await all.click()
    await expect(open).toBeVisible({ timeout: 1_000 })
  }).toPass({ timeout: 20_000 })
  return open
}

test('a run opens from the agent page inside the new shell, and Back returns to it', async () => {
  await page.goto('/b/team/designer')
  await page.getByRole('button', { name: /^More/ }).click()
  // The runs load after the agent page under a busy server.
  const open = await openRunLink(page)
  await open.click()
  await expect(page).toHaveURL(/\/b\/attempts\/[^/]+$/)
  await expect(page.locator('.bold-classic-page .attempt-card')).toBeVisible()
  await expect(page.getByRole('heading', { level: 1, name: /^Task run by/ })).toBeVisible()
  await page.getByRole('button', { name: '← Back' }).click()
  await expect(page).toHaveURL(/\/b\/team\/designer/)
})

test('the old /attempts address redirects into the frame and keeps the query', async () => {
  await page.goto('/b/team/designer')
  await page.getByRole('button', { name: /^More/ }).click()
  const href = await (await openRunLink(page)).getAttribute('href')
  const id = href!.split('/').pop()!
  await page.goto(`/attempts/${id}?x=1`)
  await expect(page).toHaveURL(new RegExp(`/b/attempts/${id}\\?x=1$`))
  await expect(page.locator('.bold-classic-page .attempt-card')).toBeVisible()
})
