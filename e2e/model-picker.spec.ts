import { expect, test } from '@playwright/test'
import { pair } from './pair.ts'

test('pick a model from the connected providers in Add agent and on the Model tab', async ({
  page,
}) => {
  await pair(page)
  await page.goto('/team')
  await page.getByRole('button', { name: 'Add agent', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Add agent' })
  await dialog.getByLabel('Profile name').fill('picker-helper')
  await dialog.getByLabel('Role / description').fill('Checks the model picker')
  const picker = dialog.getByRole('combobox', { name: 'Model' })
  await picker.fill('gpt')
  const list = dialog.getByRole('listbox', { name: 'Model suggestions' })
  await expect(list.getByRole('group', { name: 'ChatGPT (Codex)' })).toBeVisible()
  await expect(list.getByRole('group', { name: 'Nous Portal' })).toBeVisible()
  await expect(
    list.getByRole('option', { name: /^gpt-6.1-sol.*\$2.00 \/ \$10.00 per 1M/ }),
  ).toBeVisible()
  const unavailable = list.getByRole('option', { name: /openai\/gpt-6.1-sol/ })
  await expect(unavailable).toHaveAttribute('aria-disabled', 'true')
  await expect(unavailable).toContainText('Not on your plan')
  await list.getByRole('option', { name: /^gpt-6.1-sol/ }).click()
  await expect(picker).toHaveValue('gpt-6.1-sol')
  await dialog.getByRole('button', { name: 'Preview changes' }).click()
  await expect(dialog.getByText('Set the model to gpt-6.1-sol via ChatGPT (Codex).')).toBeVisible()
  await dialog.getByRole('button', { name: 'Create agent' }).click()
  await expect(dialog.getByRole('heading', { name: 'Ready', exact: true })).toBeVisible()
  await dialog.getByRole('link', { name: 'View agent' }).click()

  await page.getByRole('tab', { name: 'Model' }).click()
  const panel = page.getByRole('tabpanel')
  await expect(panel.getByText('Through openai-codex.')).toBeVisible()
  const tabPicker = panel.getByRole('combobox', { name: 'Model' })
  await tabPicker.fill('solar')
  await expect(panel.getByRole('option', { name: /upstage/ })).toBeVisible()
  await expect(panel.getByRole('option')).toHaveCount(1)
  await tabPicker.press('ArrowDown')
  await tabPicker.press('Enter')
  await expect(tabPicker).toHaveValue('upstage/solar-mini4:free')
  await panel.getByRole('button', { name: 'Change model' }).click()
  await expect(panel.getByText('Saved: upstage/solar-mini4:free')).toBeVisible()
  await expect(panel.getByText('Through nous.')).toBeVisible()

  await page.getByRole('tab', { name: 'Overview' }).click()
  await page.getByRole('button', { name: 'Delete agent', exact: true }).click()
  await page.getByLabel('Type picker-helper to confirm').fill('picker-helper')
  await page.getByRole('button', { name: 'Confirm deletion' }).click()
  await expect(page.getByRole('heading', { name: 'Agent removed' })).toBeVisible()
})
