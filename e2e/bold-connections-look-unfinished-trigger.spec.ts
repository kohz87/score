import { expect, test } from '@playwright/test'
import { openBoldSettings } from './bold-connections-look-helpers.ts'
import { pair } from './pair.ts'

test('closing a new trigger before it is saved offers to delete the live address', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await pair(page)
  await openBoldSettings(page, 'tools')
  const name = `Unfinished ${Date.now().toString(36)}`
  await page.getByRole('button', { name: 'New trigger' }).click()
  const dialog = page.getByRole('dialog', { name: 'New trigger' })
  await dialog.getByLabel('Name').fill(name)
  await dialog.getByLabel('App it comes from').fill('Tickets app')
  await dialog.getByRole('button', { name: 'Create the address' }).click()
  await dialog.getByRole('button', { name: 'Close secret' }).click()
  await dialog.getByRole('button', { name: 'Finish later' }).click()
  const confirm = page.getByRole('alertdialog', { name: 'Keep this unfinished trigger?' })
  await expect(confirm).toContainText('already live')
  await confirm.getByRole('button', { name: 'Delete trigger' }).click()
  await expect(confirm).toBeHidden()
  await expect
    .poll(async () => {
      const response = await page.request.get('/api/triggers')
      const body = (await response.json()) as { items: { name: string }[] }
      return body.items.some((trigger) => trigger.name === name)
    })
    .toBe(false)
})
