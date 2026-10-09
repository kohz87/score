import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'

test('reports show the numbers, switch range and export the table as CSV', async ({ page }) => {
  await page.goto('/reports')
  await expect(page.getByRole('heading', { name: 'Reports', level: 1 })).toBeVisible()
  await expect(page.getByRole('button', { name: '7 days' })).toHaveAttribute('aria-pressed', 'true')

  const totals = page.getByRole('region', { name: 'In numbers' })
  await expect(totals.getByText('tasks finished')).toBeVisible()
  await expect(totals.getByText('model spend')).toBeVisible()
  await expect(page.getByRole('region', { name: 'Tasks finished, by day' })).toBeVisible()
  await expect(page.getByRole('heading', { name: "Where each agent's time goes" })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Your approvals' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Last 30 days: spend and runs' })).toBeVisible()
  await expect(page.getByRole('table', { name: /Runs and spend per day/ })).toHaveCount(1)

  const table = page.getByRole('table', { name: 'By agent', exact: true })
  await expect(table.locator('thead th')).toHaveText([
    'Agent',
    'Finished',
    'Runs',
    'Median time',
    'First-time pass',
    'Cache hits',
    'Spend',
  ])
  await expect(table.getByRole('row')).toHaveCount(5)
  await expect(table.locator('tbody th', { hasText: 'builder' })).toBeVisible()

  await page.getByRole('button', { name: '30 days' }).click()
  await expect(page).toHaveURL(/range=30d/)
  await expect(page.getByRole('button', { name: '30 days' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(table.getByRole('row')).toHaveCount(5)

  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('link', { name: 'Export CSV' }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toMatch(/^score-report-30d-\d{4}-\d{2}-\d{2}\.csv$/)
  const csv = (await readFile((await download.path())!, 'utf8')).trimEnd().split('\r\n')
  expect(csv[0]).toBe('Agent,Finished,Runs,Median time (min),First-time pass (%),Spend (USD)')
  expect(csv).toHaveLength(5)
  const names = await table.locator('tbody th').allTextContents()
  expect(csv.slice(1).map((line) => line.split(',')[0])).toEqual(names.map((n) => n.trim()))
})

test('a custom range is chosen, kept in the URL and followed by the CSV', async ({ page }) => {
  await page.goto('/reports')
  await page.getByRole('button', { name: 'Custom' }).click()
  const dialog = page.getByRole('dialog', { name: 'Custom range' })
  const today = await dialog.getByLabel('To').getAttribute('max')
  const [y, m, d] = today!.split('-').map(Number)
  const from = new Date(Date.UTC(y!, m! - 1, d! - 44)).toISOString().slice(0, 10) // 45 days
  await dialog.getByLabel('From').fill(from)
  await dialog.getByLabel('To').fill(today!)
  await dialog.getByRole('button', { name: 'Apply' }).click()
  await expect(page).toHaveURL(new RegExp(`range=custom&from=${from}&to=${today}`))
  const chip = page.getByRole('button', { pressed: true })
  await expect(chip).toContainText('–')
  const table = page.getByRole('table', { name: 'By agent', exact: true })
  await expect(table.getByRole('row')).toHaveCount(5)
  await expect(page.locator('g[data-day]')).toHaveCount(45)

  await page.reload()
  await expect(page.getByRole('button', { pressed: true })).toContainText('–')

  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('link', { name: 'Export CSV' }).click()
  expect((await downloadPromise).suggestedFilename()).toBe(`score-report-${from}_${today}.csv`)
})
