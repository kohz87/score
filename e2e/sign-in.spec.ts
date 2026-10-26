import { expect, test, type Page } from '@playwright/test'
import { pair } from './pair.ts'

// Fake adapter: Nous Portal signs in with a device code, OpenRouter takes a pasted key, Anthropic is terminal-only.
// The bold Connections card folds the providers that aren't in use: open the whole list first.
async function providers(page: Page) {
  await page.goto('/b/settings/connections')
  const models = page.getByRole('region', { name: 'Model providers' })
  const all = models.getByRole('button', { name: /^Show all \d+ providers$/ })
  await expect(models.getByRole('button', { name: /^Remove / }).first()).toBeVisible()
  if (await all.isVisible()) await all.click()
  return models
}

const KEY = 'sk-or-e2e-not-a-real-key-0001'

test('a device-code sign-in shows the link and code and ends connected', async ({ page }) => {
  await pair(page)
  const models = await providers(page)
  await models.getByRole('button', { name: /^(Connect|Edit) Nous Portal$/ }).click()
  const panel = models.getByRole('group', { name: 'Sign in to Nous Portal' })
  const link = panel.getByRole('link', { name: 'Open the sign-in page' })
  await expect(link).toHaveAttribute('href', 'https://example.com/device')
  await expect(link).toHaveAttribute('target', '_blank')
  await expect(panel.getByLabel('Sign-in code')).toHaveText('WXYZ-1234')
  await expect(panel.getByText('Waiting for you to approve…')).toBeVisible()
  // The fake approves the sign-in on the third status read, about four seconds later.
  await expect(panel.getByText('Nous Portal is connected.')).toBeVisible({ timeout: 15_000 })
  await panel.getByRole('button', { name: 'Done' }).click()
  await expect(panel).toBeHidden()
  // Connected through the browser: nothing left to edit, so no connect or edit button is offered (Remove stays).
  await expect(
    models.getByRole('button', { name: /^(Connect|Edit|Reconnect|Add key) Nous Portal$/ }),
  ).toHaveCount(0)
})

test('a pasted key connects a key provider and is never shown again', async ({ page }) => {
  await pair(page)
  const models = await providers(page)
  await models.getByRole('button', { name: /^(Connect|Add key) OpenRouter$/ }).click()
  const form = models.getByRole('form', { name: 'Add a key for OpenRouter' })
  const input = form.getByLabel('API key')
  await expect(input).toHaveAttribute('type', 'password')
  await input.fill(KEY)
  await form.getByRole('button', { name: 'Save key' }).click()
  await expect(models.getByText('OpenRouter is connected.')).toBeVisible()
  await expect(form).toBeHidden()
  await expect(page.getByText(KEY)).toHaveCount(0)
  expect(await page.content()).not.toContain(KEY)
})

test('a terminal-only provider still shows the command, and a panel can fall back to it', async ({
  page,
}) => {
  await pair(page)
  const models = await providers(page)
  await models.getByRole('button', { name: 'Reconnect Anthropic' }).click()
  await expect(models.getByText('hermes auth add anthropic')).toBeVisible()
})
