import { expect, test } from '@playwright/test'
import { pair } from './pair.ts'

test('settings shows providers and connections and the command to run for a sign-in', async ({
  page,
}) => {
  await pair(page)
  await page.goto('/b/settings/connections')
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible()
  const nav = page.getByRole('navigation', { name: 'Settings' })

  const models = page.getByRole('region', { name: 'Model providers' })
  // The card folds providers that aren't in use (and sign-in.spec connects some on the same server).
  const all = models.getByRole('button', { name: /^Show all \d+ providers$/ })
  await expect(models.getByRole('button', { name: /^Remove / }).first()).toBeVisible()
  if (await all.isVisible()) await all.click()
  await expect(models.getByText('OpenRouter')).toBeVisible()
  await expect(models.getByText('Your ChatGPT plan')).toBeVisible()
  // The row that needs a new sign-in says why (the server's words) and offers Reconnect.
  await expect(
    models.locator('[data-provider-status="needs_signin"]').getByText('Session expired'),
  ).toBeVisible()
  // The bold card names the agents on the demo provider in words (never by colour alone).
  await expect(models.getByText('lead, builder, reviewer, designer')).toBeVisible()

  // Connecting needs a paired browser, so the request is stubbed; the UI contract is what is checked.
  await page.route('**/api/settings/providers/anthropic/connect', (route) =>
    route.fulfill({ json: { next: 'run_in_terminal', command: 'hermes auth add anthropic' } }),
  )
  await models.getByRole('button', { name: 'Reconnect Anthropic' }).click()
  const command = page.getByRole('group', { name: 'Run in a terminal' })
  await expect(command.getByText('hermes auth add anthropic')).toBeVisible()
  await command.getByRole('button', { name: 'Done' }).click()
  await expect(command).toBeHidden()

  // Tools and triggers is a section of its own; the channels sit next to the providers.
  await expect(page.getByRole('region', { name: 'Channels' }).getByText('Telegram')).toBeVisible()
  await expect(page.getByRole('region', { name: 'Tools and triggers' })).toHaveCount(0)
  await nav.getByRole('button', { name: /^Tools and triggers/ }).click()
  await expect(page.getByText('web-search')).toBeVisible()
  await expect(page.getByText('Coming soon.')).toHaveCount(0)
})
