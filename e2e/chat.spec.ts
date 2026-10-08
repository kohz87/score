import { expect, test } from '@playwright/test'

test('fake Chat opens rooms and directs with keyboard access and a passive composer', async ({
  page,
}) => {
  await page.goto('/chat')
  await expect(page.getByRole('heading', { name: 'Chat', level: 1 })).toBeVisible()
  const conversations = page.getByRole('navigation', { name: 'Conversations' })
  const room = conversations.getByRole('link', { name: /#activity-feed/ })
  await expect(room).toBeVisible({ timeout: 15_000 })
  await room.focus()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL('/chat/room-activity-feed')
  await expect(page.getByRole('heading', { name: '#activity-feed', level: 1 })).toBeVisible()
  await expect(room).toHaveAttribute('aria-current', 'page')
  await expect(page.getByText('Unaddressed messages go to lead')).toBeVisible()
  const history = page.getByRole('region', { name: 'Message history' })
  await expect(history.getByRole('article').first()).toBeVisible({ timeout: 15_000 })
  await expect(
    history.getByText(/Let’s add pagination while keeping the newest activity visible./).first(),
  ).toBeAttached()
  await history.focus()
  await expect(history).toBeFocused()
  await page.keyboard.press('End')
  await expect(page.getByRole('textbox')).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled()
  await expect(conversations.getByRole('link', { name: /lead/i }).last()).toBeVisible()
  const direct = conversations.getByRole('link').filter({ hasText: /^lead/ }).first()
  await direct.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { name: 'lead', exact: true })).toBeVisible()
  await expect(direct).toHaveAttribute('aria-current', 'page')
  await page.setViewportSize({ width: 360, height: 800 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360)
})
