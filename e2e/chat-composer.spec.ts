import { expect, test } from '@playwright/test'
import { pair } from './pair.ts'

test('the composer sends a message that gets a streamed reply, and an /assign that creates a task', async ({
  page,
}) => {
  await pair(page)
  await page.goto('/chat')
  await page
    .getByRole('navigation', { name: 'Conversations' })
    .getByRole('link', { name: /#activity-feed/ })
    .click({ timeout: 15_000 })
  const history = page.getByRole('region', { name: 'Message history' })
  await expect(history.getByRole('article').first()).toBeVisible({ timeout: 15_000 })
  const composer = page.getByRole('combobox', { name: /^Message/ })
  await expect(composer).toBeEnabled()

  // Plain message: shows up as yours at once, then an agent answers.
  const before = await history.getByRole('article').count()
  await composer.fill('Please check the room context')
  await composer.press('Enter')
  await expect(composer).toHaveValue('')
  await expect(history.getByText('Please check the room context')).toBeVisible()
  await expect(history.getByRole('article')).toHaveCount(before + 2, { timeout: 20_000 })
  await expect(history.getByRole('article').last()).toHaveAccessibleName(/Message from lead/)

  // Slash menu and @autocomplete are keyboard driven.
  await composer.fill('/')
  const commands = page.getByRole('listbox', { name: 'Commands' })
  await expect(commands.getByRole('option')).toHaveCount(5)
  await composer.press('Enter')
  await expect(composer).toHaveValue('/assign ')
  await composer.pressSequentially('@bu')
  await expect(page.getByRole('listbox', { name: 'Agents' })).toBeVisible()
  await composer.press('Tab')
  await expect(composer).toHaveValue('/assign @builder ')
  const title = `Composer task ${Date.now()}`
  await composer.pressSequentially(title)
  await composer.press('Enter')
  const created = page.getByRole('status').filter({ hasText: 'Created task' })
  await expect(created).toBeVisible()

  await created.getByRole('link').click()
  await expect(page).toHaveURL(/\/tasks\//)
  await page.goto('/tasks')
  await expect(page.getByText(title).first()).toBeVisible({ timeout: 15_000 })
})
