import { expect, test } from '@playwright/test'

test('settings shows providers and connections and the command to run for a sign-in', async ({
  page,
}) => {
  await page.goto('/settings')
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible()
  const nav = page.getByRole('navigation', { name: 'Settings sections' })
  await expect(nav.getByRole('link')).toHaveCount(7)

  const models = page.getByRole('region', { name: 'Models and keys' })
  await expect(models.getByText('OpenRouter')).toBeVisible()
  await expect(models.getByText('Your ChatGPT plan')).toBeVisible()
  await expect(models.getByText('Sign in again')).toBeVisible()
  // Agents on the demo provider are identified by glyph (color and shape).
  await expect(models.getByRole('img', { name: /builder/i }).first()).toBeVisible()

  const connections = page.getByRole('region', { name: 'Connections' })
  await expect(connections.getByText('web-search')).toBeVisible()
  await expect(connections.getByText('Telegram')).toBeVisible()
  await expect(page.getByText('Coming soon.')).toHaveCount(0)

  // Connecting needs a paired browser, so the request is stubbed; the UI contract is what is checked.
  await page.route('**/api/settings/providers/anthropic/connect', (route) =>
    route.fulfill({ json: { next: 'run_in_terminal', command: 'hermes auth add anthropic' } }),
  )
  await models.getByRole('button', { name: 'Reconnect Anthropic' }).click()
  const command = page.getByRole('group', { name: 'Run in a terminal' })
  await expect(command.getByText('hermes auth add anthropic')).toBeVisible()
  await command.getByRole('button', { name: 'Done' }).click()
  await expect(command).toBeHidden()
})
