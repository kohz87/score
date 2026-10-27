import { readFile } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import { pair } from './pair.ts'

// PLAN 11.9c: Settings › Usage on the bold shell, at desktop and phone widths, with its range, table and motion.

async function openUsage(page: Page) {
  await pair(page)
  await page.goto('/b/settings/usage')
  await expect(page.getByRole('heading', { name: 'Usage' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Usage in numbers' })).toBeVisible()
}

test('Usage fits 1440×900 and 390×844 with the phone nav above the content', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await openUsage(page)
  const nav = page.getByRole('navigation', { name: 'Settings' })
  for (const label of [
    'Connections',
    'Tools and triggers',
    'Rules',
    'Notifications',
    'Look',
    'Usage',
    'Remote access and security',
    'Advanced',
    'System',
  ])
    await expect(nav.getByRole('button', { name: new RegExp(`^${label}`) })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Jobs done per day' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Spend by agent' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Your approvals' })).toHaveCount(0)

  const jobs = page.getByRole('region', { name: 'Jobs done per day' })
  await expect(jobs.locator('[data-part="bar"]')).toHaveCount(7)
  await expect(jobs.locator('.usage-jobs-bar--busiest')).toHaveCount(1)
  // The fake report moves with the date: the busiest day carries its count, whatever it is today.
  await expect(jobs.locator('.usage-jobs-value')).toHaveText(/^[1-9]\d*$/)
  // The fake report is relative to today: seven weekday labels, whichever day the run lands on.
  await expect(jobs.locator('.usage-jobs-label')).toHaveText(
    Array.from({ length: 7 }, () => /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)$/),
  )
  await expect(page.locator('.usage-spend-name')).toHaveText([
    'builder',
    'designer',
    'reviewer',
    'lead',
  ])
  // 3.7.13 (owner): a long amount beside the longest bar stays inside the card ("$0.49 estimated" overflowed).
  const spend = page.getByRole('region', { name: 'Spend by agent' })
  await spend
    .locator('.usage-spend-value')
    .first()
    .evaluate((node) => {
      node.textContent = '$0.49 estimated'
    })
  const card = (await spend.boundingBox())!
  for (const value of await spend.locator('.usage-spend-value').all()) {
    const box = (await value.boundingBox())!
    expect(box.x + box.width).toBeLessThanOrEqual(card.x + card.width)
  }
  await page.screenshot({ path: testInfo.outputPath('bold-usage-1440.png'), fullPage: true })

  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByRole('button', { name: 'Score, go to the team room' })).toBeVisible()
  // And on a phone, where the card is narrowest.
  const phoneCard = (await spend.boundingBox())!
  for (const value of await spend.locator('.usage-spend-value').all()) {
    const box = (await value.boundingBox())!
    expect(box.x + box.width).toBeLessThanOrEqual(phoneCard.x + phoneCard.width)
  }
  const navBox = await nav.boundingBox()
  const mainBox = await page.locator('.bold-settings-page .setmain').boundingBox()
  expect(navBox).not.toBeNull()
  expect(mainBox).not.toBeNull()
  expect(navBox!.y + navBox!.height).toBeLessThanOrEqual(mainBox!.y)
  expect(navBox!.width).toBeGreaterThan(300)
  await page.screenshot({ path: testInfo.outputPath('bold-usage-390.png'), fullPage: true })
})

test('switching the range refetches and updates the CSV link', async ({ page }) => {
  await openUsage(page)
  await expect(page.getByRole('link', { name: 'Download CSV' })).toHaveAttribute('href', /range=7d/)
  const response = page.waitForResponse(
    (candidate) =>
      candidate.url().includes('/api/reports?') && candidate.url().includes('range=30d'),
  )
  await page.getByRole('button', { name: '30 days' }).click()
  await response
  await expect(page).toHaveURL(/\/b\/settings\/usage\?range=30d/)
  await expect(page.getByRole('button', { name: '30 days' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(page.getByRole('link', { name: 'Download CSV' })).toHaveAttribute(
    'href',
    /range=30d/,
  )
})

// Ported from reports.spec.ts (the Reports page was folded into Usage, decision 132): the CSV is a real download.
test('Download CSV delivers the rows of the chosen range', async ({ page }) => {
  await openUsage(page)
  await page.getByRole('button', { name: '30 days' }).click()
  await expect(page).toHaveURL(/range=30d/)
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('link', { name: 'Download CSV' }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toMatch(/^score-report-30d-\d{4}-\d{2}-\d{2}\.csv$/)
  const csv = (await readFile((await download.path())!, 'utf8')).trimEnd().split('\r\n')
  expect(csv[0]).toBe('Agent,Finished,Runs,Median time (min),First-time pass (%),Spend (USD)')
  expect(csv.length).toBeGreaterThan(1)
  const names = csv.slice(1).map((line) => line.split(',')[0])
  expect(names).toContain('builder')
})

test('Show as table reveals the same task rows', async ({ page }) => {
  await openUsage(page)
  const card = page.getByRole('region', { name: 'Jobs done per day' })
  await card.getByRole('button', { name: 'Show as table' }).click()
  await expect(card.getByRole('button', { name: 'Hide table' })).toBeVisible()
  const table = card.getByRole('table', { name: 'Jobs done per day, by agent' })
  await expect(table).toBeVisible()
  await expect(table.locator('tbody tr')).not.toHaveCount(0)
  await expect(table.locator('thead th').nth(0)).toHaveText('Day')
  await expect(table.locator('thead th').nth(1)).toHaveText('Jobs done')
})

test('Custom range and the By agent table, desktop and phone', async ({ page }) => {
  await openUsage(page)
  const table = page.getByRole('table', { name: 'By agent', exact: true })
  await expect(table).toBeVisible()
  await expect(table.locator('tbody tr')).not.toHaveCount(0)
  await expect(table.getByRole('rowheader', { name: 'builder' })).toBeVisible()

  await page.getByRole('button', { name: 'Custom' }).click()
  const form = page.getByRole('form', { name: 'Custom range' })
  const from = new Date(Date.now() - 4 * 86_400_000).toISOString().slice(0, 10)
  await form.getByLabel('From').fill(from)
  await form.getByLabel('To').fill(new Date().toISOString().slice(0, 10))
  const response = page.waitForResponse(
    (candidate) =>
      candidate.url().includes('/api/reports?') && candidate.url().includes('range=custom'),
  )
  await form.getByRole('button', { name: 'Apply' }).click()
  await response
  await expect(page).toHaveURL(/range=custom&from=/)
  await expect(page.getByRole('link', { name: 'Download CSV' })).toHaveAttribute(
    'href',
    /range=custom&from=/,
  )
  await expect(table).toBeVisible()

  // Phone: the page itself never scrolls sideways; the table scrolls inside its own box.
  await page.setViewportSize({ width: 390, height: 844 })
  const scroller = page.getByRole('region', { name: /By agent table/ })
  await expect(scroller).toBeVisible()
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow).toBeLessThanOrEqual(0)
})

test('Journey view shows one row per agent and a text alternative', async ({ page }) => {
  await pair(page)
  await page.goto('/b/settings/usage?tab=journey')
  await expect(page.getByRole('heading', { name: /^Journey: tasks, notes/ })).toBeVisible()
  await expect(page.locator('.journey__row').first()).toBeVisible()
  await expect(page.getByRole('list', { name: 'Legend' })).toBeVisible()
  await expect(page.getByRole('table', { name: 'Journey counts per agent' })).toBeAttached()
  await page.getByRole('button', { name: 'Overview' }).click()
  await expect(page.getByRole('region', { name: 'Usage in numbers' })).toBeVisible()
})

test.describe('reduced motion', () => {
  test.use({ reducedMotion: 'reduce', viewport: { width: 1440, height: 900 } })

  test('nothing on Settings › Usage keeps a running animation', async ({ page }) => {
    await openUsage(page)
    await page.locator('[data-ui="bold"]').evaluate((root) => {
      const probe = document.createElement('span')
      probe.className = 'livedot'
      probe.dataset.motionProbe = 'true'
      root.append(probe)
    })
    const probe = page.locator('[data-motion-probe="true"]')
    expect(await probe.evaluate((element) => getComputedStyle(element).animationName)).toBe('none')
    const running = await page.locator('[data-ui="bold"]').evaluate((root) =>
      root
        .getAnimations({ subtree: true })
        .filter((animation) => animation.playState === 'running')
        .map((animation) => (animation as CSSAnimation).animationName ?? 'transition'),
    )
    expect(running).toEqual([])
  })
})
