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

  // Plain message: shows up as yours at once, then an agent answers. Other specs may post in this room
  // at the same time, so wait for the reply after this message rather than counting messages.
  const text = `Please check the room context ${Date.now()}`
  await composer.fill(text)
  await composer.press('Enter')
  await expect(composer).toHaveValue('')
  const mine = history.getByRole('article').filter({ hasText: text })
  await expect(mine).toBeVisible()
  const reply = mine
    .locator('xpath=following-sibling::*[@role="article" or self::article]')
    .filter({
      hasText: 'I have reviewed the room context',
    })
  await expect(reply.first()).toHaveAccessibleName(/Message from lead/, { timeout: 20_000 })

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
  // In-app navigation: a full page load of the dev build can lose module requests (see now.spec.ts).
  await page.getByRole('navigation', { name: /main/i }).getByRole('link', { name: 'Tasks' }).click()
  await expect(page.getByText(title).first()).toBeVisible({ timeout: 15_000 })
})
