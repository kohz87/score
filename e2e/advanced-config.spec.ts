import { expect, test } from '@playwright/test'
import { pair } from './pair.ts'

test('advanced settings: search by name and comment, preview the diff, apply, and credentials stay hidden', async ({
  page,
}) => {
  await pair(page)
  await page.goto('/settings')
  const advanced = page.getByRole('region', { name: 'Advanced' })
  const search = advanced.getByRole('searchbox', { name: 'Search settings' })

  // Collapsed until asked for: heading, search and the disclosure only.
  await expect(advanced.getByRole('button', { name: /^Show all \d+ settings$/ })).toBeVisible()
  await expect(advanced.getByRole('list', { name: 'Settings' })).toHaveCount(0)

  await search.fill('max_turns')
  await expect(advanced.getByText('agent.max_turns')).toBeVisible()
  await search.fill('long-term memory')
  await expect(advanced.getByText('memory.enabled')).toBeVisible()

  // Credential-shaped settings exist in the fake config but are never offered.
  await search.fill('vision')
  await expect(advanced.getByText('auxiliary.vision.provider')).toBeVisible()
  await expect(advanced.getByText('api_key')).toHaveCount(0)
  await expect(page.getByText('fake-secret-do-not-show')).toHaveCount(0)

  await search.fill('compact')
  await advanced.getByRole('button', { name: 'Edit display.compact' }).click()
  await advanced.getByLabel('New value for display.compact').fill('true')
  await advanced.getByRole('button', { name: 'Stage change' }).click()
  const tray = advanced.getByRole('group', { name: 'Pending changes' })
  await expect(tray.getByText('display.compact = true')).toBeVisible()
  await expect(tray.getByRole('button', { name: 'Apply' })).toBeDisabled()
  await tray.getByRole('button', { name: 'Preview' }).click()
  await expect(tray.getByLabel('Diff')).toContainText('+display.compact: true')
  await tray.getByRole('button', { name: 'Apply' }).click()
  await expect(advanced.getByText(/Saved\./)).toBeVisible()
  await expect(advanced.getByText('true', { exact: true })).toBeVisible()
})
