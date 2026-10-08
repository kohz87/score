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

  const table = page.getByRole('table', { name: 'By agent', exact: true })
  await expect(table.locator('thead th')).toHaveText([
    'Agent',
    'Finished',
    'Runs',
    'Median time',
    'First-time pass',
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
