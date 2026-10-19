import { expect, test } from '@playwright/test'
import { pair } from './pair.ts'

test('add an agent, observe setup and readiness, then export and delete with its typed name', async ({
  page,
}) => {
  await pair(page)
  await page.goto('/team')
  await page.getByRole('button', { name: 'Add agent', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Add agent' })
  await dialog.getByLabel('Agent name').fill('profile-test-helper')
  await dialog.getByLabel('Role or description').fill('Helps the team test profile management')
  await dialog.getByLabel('Model', { exact: true }).fill('fake-model')
  await dialog.getByRole('radio', { name: 'hexagon' }).check()
  await dialog.getByRole('button', { name: 'Preview changes' }).click()
  await expect(dialog.getByRole('heading', { name: 'Review changes' })).toBeVisible()
  await dialog.getByRole('button', { name: 'Create agent' }).click()
  await expect(dialog.getByRole('heading', { name: 'Setting up' })).toBeVisible()
  await expect(dialog.getByRole('heading', { name: / joined the team$/ })).toBeVisible()
  await dialog.getByRole('link', { name: /^Open / }).click()
  await expect(
    page.getByRole('heading', { name: 'profile-test-helper', exact: true }),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Delete agent', exact: true }).click()
  await expect(page.getByText(/omits credentials and is not a full undo/)).toBeVisible()
  await expect(page.getByText(/Private export:/).first()).toContainText('/profile-backups/')
  const confirm = page.getByRole('button', { name: 'Confirm deletion' })
  await expect(confirm).toBeDisabled()
  await page.getByLabel('Type profile-test-helper to confirm').fill('wrong-name')
  await expect(confirm).toBeDisabled()
  await page.getByLabel('Type profile-test-helper to confirm').fill('profile-test-helper')
  await confirm.click()
  await expect(page.getByRole('heading', { name: 'Agent removed' })).toBeVisible()
  await page.goto('/team')
  await expect(page.getByRole('heading', { name: 'profile-test-helper' })).toHaveCount(0)
})
