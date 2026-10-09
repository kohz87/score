import { expect, test } from '@playwright/test'

test('Reports › Journey shows a row per agent, a legend and the counts as text', async ({
  page,
}) => {
  await page.goto('/reports')
  await page.getByRole('button', { name: 'Journey' }).click()
  await expect(page).toHaveURL(/tab=journey/)
  await expect(
    page.getByRole('img', { name: /Journey from .* marks across 4 agents/ }),
  ).toBeVisible()
  const legend = page.getByRole('list', { name: 'Legend' })
  await expect(legend.getByText('Memory file changed')).toBeVisible()
  const counts = page.getByRole('table', { name: 'Journey counts per agent' })
  await expect(counts.getByRole('row')).toHaveCount(5)
  const totals = await counts.locator('tbody td').allTextContents()
  expect(totals.reduce((sum, value) => sum + Number(value), 0)).toBeGreaterThan(0)
  await page.getByRole('button', { name: '30 days' }).click()
  await expect(page.getByRole('img', { name: /Journey from/ })).toBeVisible()
  await page.getByRole('button', { name: 'Overview' }).click()
  await expect(page.getByRole('table', { name: 'By agent', exact: true })).toBeVisible()
})

test('the pop-out page shows one agent compactly and Team opens it in its own window', async ({
  page,
  context,
}) => {
  await page.goto('/agents/builder/pop')
  await expect(page.getByRole('heading', { name: 'builder', level: 1 })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Now' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Current run' })).toBeVisible()
  await expect(page.getByRole('combobox', { name: /^Message/ })).toBeVisible()
  await expect(page.getByRole('navigation')).toHaveCount(0)

  await page.goto('/team/builder')
  const popup = context.waitForEvent('page')
  await page.getByRole('button', { name: 'Open builder in its own window' }).click()
  const opened = await popup
  await expect(opened).toHaveURL(/\/agents\/builder\/pop$/)
  await expect(opened.getByRole('heading', { name: 'builder', level: 1 })).toBeVisible()
  await opened.close()
})
