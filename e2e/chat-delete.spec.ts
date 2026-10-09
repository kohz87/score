import { expect, test } from '@playwright/test'
import { pair } from './pair.ts'

test('Delete hides a message with an Undo window, then removes it for real', async ({ page }) => {
  await pair(page)
  await page.goto('/chat')
  await page
    .getByRole('navigation', { name: 'Conversations' })
    .getByRole('link', { name: /#activity-feed/ })
    .click({ timeout: 15_000 })
  const history = page.getByRole('region', { name: 'Message history' })
  await expect(history.getByRole('article').first()).toBeVisible({ timeout: 15_000 })
  const composer = page.getByRole('combobox', { name: /^Message/ })
  const text = `Delete me ${Date.now()}`
  await composer.fill(text)
  await composer.press('Enter')
  // An agent reply: deleting it stays Score-only with an Undo window (your own messages rewind, chat-rewind.spec.ts).
  const replies = history.getByRole('article', { name: /Message from Lead/ }).filter({
    hasText: 'I have reviewed the room context',
  })
  await expect(replies.first()).toBeVisible({ timeout: 40_000 })
  const before = await replies.count()
  const mine = replies.first()
  const all = replies

  await mine.hover()
  await mine.getByRole('button', { name: 'Delete message from Lead' }).click()
  await expect(all).toHaveCount(before - 1)
  const toast = page.getByRole('status').filter({ hasText: 'Message deleted' })
  await expect(
    toast.getByText('Removes it from Score. Agents may still remember it.'),
  ).toBeVisible()
  await toast.getByRole('button', { name: 'Undo' }).click()
  await expect(all).toHaveCount(before)

  const deleted = page.waitForResponse(
    (response) => response.request().method() === 'DELETE' && response.status() === 204,
  )
  await mine.hover()
  await mine.getByRole('button', { name: 'Delete message from Lead' }).click()
  await deleted
  await page.reload()
  await expect(history.getByRole('article').first()).toBeVisible({ timeout: 15_000 })
  await expect(all).toHaveCount(before - 1)
})
