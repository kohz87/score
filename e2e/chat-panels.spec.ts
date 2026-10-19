import { expect, test } from '@playwright/test'

test('fake Chat shows the room side panels and collapses them on a narrow window', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/chat/room-activity-feed')
  const panels = page.getByRole('complementary', { name: 'About this room' })
  await expect(panels).toBeVisible({ timeout: 15_000 })
  await expect(panels.getByRole('heading', { name: 'Files in play' })).toBeVisible()
  await expect(panels.getByRole('heading', { name: 'Learned here' })).toBeVisible()
  await expect(panels.getByRole('heading', { name: 'Also reachable on' })).toBeVisible()
  await expect(panels.getByRole('link', { name: 'Manage channels' })).toHaveAttribute(
    'href',
    '/settings/connections',
  )
  await page.setViewportSize({ width: 900, height: 900 })
  await expect(panels).toBeHidden()
  await page.getByRole('button', { name: 'Show room details' }).click()
  await expect(panels).toBeVisible()
})
