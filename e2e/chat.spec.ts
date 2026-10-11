import { expect, test } from '@playwright/test'
import { pair } from './pair.ts'
import { makeRoom, say } from './rooms.ts'

test('fake Chat opens rooms and directs with keyboard access and an enabled composer', async ({
  page,
}) => {
  // Own room: #activity-feed is shared with every spec that posts, and the scripted ask scrolls out of its 50-message page.
  await pair(page)
  const made = await makeRoom(page, 'kbd')
  const asked = `Where are we with pagination ${Date.now()}`
  await say(page, made.id, asked)
  await page.goto('/chat')
  await expect(page.getByRole('heading', { name: 'Chat', level: 1 })).toBeVisible()
  const conversations = page.getByRole('navigation', { name: 'Rooms' })
  // The seeded room is listed; the keyboard walk below uses the room this spec made.
  await expect(conversations.getByRole('link', { name: /#activity-feed/ })).toBeVisible({
    timeout: 15_000,
  })
  const room = conversations.getByRole('link', { name: made.label })
  await expect(room).toBeVisible({ timeout: 15_000 })
  await room.focus()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(`/chat/${made.id}`)
  await expect(page.getByRole('heading', { name: made.label, level: 1 })).toBeVisible()
  await expect(room).toHaveAttribute('aria-current', 'page')
  await expect(page.getByText('Unaddressed messages go to lead')).toBeVisible()
  const history = page.getByRole('region', { name: 'Message history' })
  await expect(history.getByText(asked).first()).toBeAttached({ timeout: 15_000 })
  await history.focus()
  await expect(history).toBeFocused()
  await page.keyboard.press('End')
  await expect(page.getByRole('combobox', { name: /^Message/ })).toBeEnabled()
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
