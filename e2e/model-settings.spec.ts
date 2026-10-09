import { expect, test } from '@playwright/test'
import { pair } from './pair.ts'

// 5.31 on the fake adapter: fallback chain, aliases and speech models on the Model tab, and the chosen-models list in
// Settings. Everything is undone at the end so other specs see the demo as it was.
test('fallback chain, aliases, speech models and the chosen-models list', async ({ page }) => {
  await pair(page)
  await page.goto('/team/designer')
  await page.getByRole('tab', { name: 'Model' }).click()
  const panel = page.getByRole('tabpanel')

  const chain = panel.getByRole('group', { name: 'Fallback models' })
  await expect(chain.getByText('No fallback configured.')).toBeVisible()
  const add = chain.getByRole('combobox', { name: 'Add a fallback model' })
  await add.fill('solar')
  await chain.getByRole('option', { name: /upstage/ }).click()
  await chain.getByRole('button', { name: 'Add to chain' }).click()
  await chain.getByRole('button', { name: 'Save fallbacks' }).click()
  await expect(chain.getByText('1. upstage/solar-mini4:free')).toBeVisible()
  await expect(panel.getByText('Falls back to upstage/solar-mini4:free if it')).toBeVisible()

  const aliases = panel.getByRole('group', { name: 'Aliases' })
  const form = aliases.getByRole('form', { name: 'Add alias' })
  await form.getByLabel('Alias name').fill('quick')
  const target = form.getByRole('combobox', { name: 'Model it stands for' })
  await target.fill('local-gpt')
  await form.getByRole('option', { name: /local-gpt-mini/ }).click()
  await form.getByRole('button', { name: 'Add alias' }).click()
  await expect(aliases.getByRole('list', { name: 'Aliases' }).getByText('quick')).toBeVisible()
  // The picker finds the alias by its name.
  const main = panel.getByRole('combobox', { name: 'Model', exact: true })
  await main.fill('quick')
  await expect(panel.getByRole('option', { name: /quick → local-gpt-mini/ })).toBeVisible()

  const speech = panel.getByRole('form', { name: 'Speech models' })
  await speech.locator('select').nth(1).selectOption('openai')
  await speech.getByLabel('Voice').fill('nova')
  await speech.getByRole('button', { name: 'Save speech models' }).click()
  await page.reload()
  await page.getByRole('tab', { name: 'Model' }).click()
  await expect(page.getByLabel('Voice')).toHaveValue('nova')

  // Settings: choose one model; the pickers list only it until Show all.
  await page.goto('/settings')
  const chosen = page.getByRole('group', { name: 'Chosen models' })
  await chosen.getByLabel('Search models').fill('local-gpt-mini')
  await chosen.getByRole('checkbox', { name: /local-gpt-mini/ }).check()
  await chosen.getByRole('button', { name: 'Save chosen models' }).click()
  await expect(chosen.getByText('1 chosen. Pickers list only these.')).toBeVisible()
  await page.goto('/team/designer')
  await page.getByRole('tab', { name: 'Model' }).click()
  const picker = page.getByRole('tabpanel').getByRole('combobox', { name: 'Model', exact: true })
  await picker.fill('')
  await picker.focus()
  const list = page.getByRole('listbox', { name: 'Model suggestions' })
  await expect(list.getByRole('option')).toHaveCount(1)
  await page.getByRole('button', { name: /^Show all \(\d+ more\)$/ }).click()
  await expect(list.getByRole('option').nth(1)).toBeVisible()

  // Undo.
  await page.goto('/settings')
  await page
    .getByRole('group', { name: 'Chosen models' })
    .getByRole('button', { name: 'Clear (show all)' })
    .click()
  await page.getByRole('button', { name: 'Save chosen models' }).click()
  await expect(page.getByText('None chosen: pickers list every model.')).toBeVisible()
  await page.goto('/team/designer')
  await page.getByRole('tab', { name: 'Model' }).click()
  const undo = page.getByRole('tabpanel')
  await undo.getByRole('button', { name: 'Remove alias quick' }).click()
  await expect(undo.getByText('No aliases yet.')).toBeVisible()
  await undo.getByRole('button', { name: 'Remove upstage/solar-mini4:free' }).click()
  await undo.getByRole('button', { name: 'Save fallbacks' }).click()
  await expect(undo.getByText('No fallback configured.').first()).toBeVisible()
})
