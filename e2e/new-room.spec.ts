import { expect, test } from '@playwright/test'
import { pair } from './pair.ts'

test('New room creates a room with the chosen lead and members and opens it', async ({ page }) => {
  await pair(page)
  await page.goto('/chat')
  await page.getByRole('button', { name: '＋ New room' }).click()
  const dialog = page.getByRole('dialog', { name: 'New room' })
  await expect(dialog).toBeVisible()
  const name = `newroom-${Date.now().toString(36)}`
  await dialog.getByLabel('Name', { exact: true }).fill('Not Valid')
  await expect(dialog.getByText(/Use lowercase letters, numbers and dashes/)).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Create room' })).toBeDisabled()
  await dialog.getByLabel('Name', { exact: true }).fill(name)
  await dialog.getByRole('combobox', { name: 'Lead' }).selectOption('lead')
  await dialog.getByRole('checkbox', { name: /builder/i }).check()
  await dialog.getByRole('button', { name: 'Create room' }).click()
  await expect(dialog).toBeHidden()
  await expect(page).toHaveURL(/\/chat\/[^/]+$/)
  await expect(
    page.getByRole('navigation', { name: 'Rooms' }).getByRole('link', { name: `#${name}` }),
  ).toBeVisible()
})
