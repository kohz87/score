import { expect, test } from '@playwright/test'
import { pair } from './pair.ts'

test('a room can be summarised, the summary is editable and can be deleted', async ({ page }) => {
  test.setTimeout(120_000)
  await pair(page)
  const name = `sum-${Date.now().toString(36)}`
  const made = await page.request.post('/api/rooms', {
    headers: { 'x-score-client': 'web' },
    data: { name, leadAgentId: 'lead', members: ['lead'] },
  })
  expect(made.ok()).toBe(true)
  await page.goto('/chat')
  await page
    .getByRole('navigation', { name: 'Rooms' })
    .getByRole('link', { name: `#${name}` })
    .click({ timeout: 15_000 })
  const history = page.getByRole('region', { name: 'Message history' })
  const composer = page.getByRole('combobox', { name: /^Message/ })
  await composer.fill(`Plan the release ${Date.now()}`)
  await composer.press('Enter')
  await expect(
    history.getByRole('article').filter({ hasText: 'I have reviewed the room context' }).first(),
  ).toBeVisible({ timeout: 40_000 })

  await page.getByRole('button', { name: `Actions for #${name}` }).click()
  await page.getByRole('menuitem', { name: 'Summaries…' }).click()
  await page.getByRole('button', { name: 'Summarise now' }).click()

  const card = history.getByRole('region', { name: 'Summary of earlier messages' })
  await expect(card).toBeVisible({ timeout: 40_000 })
  await expect(card).toContainText('earlier messages')
  await expect(card).toContainText('written by')
  await card.scrollIntoViewIfNeeded()
  await page.screenshot({ path: process.env.SUMMARY_SHOT ?? 'test-results/summary.png' })

  await card.getByRole('button', { name: 'Edit' }).click()
  await card.getByLabel('Summary text').fill('Release plan agreed by the team.')
  await card.getByRole('button', { name: 'Save' }).click()
  await expect(card).toContainText('Release plan agreed by the team.')
  await expect(card).toContainText('edited by you')

  await card.getByRole('button', { name: 'Delete' }).click()
  await card.getByRole('button', { name: 'Delete summary' }).click()
  await expect(card).toHaveCount(0)
})
