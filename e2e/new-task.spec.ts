import { expect, test } from '@playwright/test'
import { pair } from './pair.ts'

test('Tasks › New task: the dialog creates a task and the card appears live', async ({ page }) => {
  await pair(page)
  await page.goto('/tasks')
  const title = `E2E new task ${Date.now()}`
  await page.getByRole('button', { name: 'New task' }).click()
  const dialog = page.getByRole('dialog', { name: 'New task' })
  await expect(dialog.getByLabel('Title')).toBeFocused()
  await expect(dialog.getByRole('button', { name: 'Create task' })).toBeDisabled()
  await dialog.getByLabel('Title').fill(title)
  await dialog.getByLabel('Details').fill('Created from the dialog.')
  await dialog.getByLabel('Assignee').selectOption({ label: 'builder' })
  await dialog.getByLabel(/^Steps/).fill('Draft it\nCheck it')
  await dialog.getByRole('button', { name: 'Create task' }).click()
  await expect(dialog).toBeHidden()
  const card = page.getByRole('link', { name: new RegExp(title) })
  await expect(card).toBeVisible()
  await expect(page.getByRole('button', { name: 'New task' })).toBeFocused()
  await card.click()
  await expect(page.getByText('Draft it', { exact: true })).toBeVisible()
})

test('Tasks › New task: Escape closes the dialog without creating anything', async ({ page }) => {
  await page.goto('/tasks')
  await page.getByRole('button', { name: 'New task' }).click()
  const dialog = page.getByRole('dialog', { name: 'New task' })
  await dialog.getByLabel('Title').fill('Never created')
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('button', { name: 'New task' })).toBeFocused()
  await expect(page.getByText('Never created')).toHaveCount(0)
})
