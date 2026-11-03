import { expect, test } from '@playwright/test'
import { makeRoom } from './bold-chat-helpers.ts'
import { pair } from './pair.ts'

// 3.21.0: the messenger layout (chat list, chat header, Info tab, phone list), docs/design/bold/mockups/18-chats*.

test('the list shows the team room and the directs; a direct opens and the list brings us back', async ({
  page,
}) => {
  await pair(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/b')
  const nav = page.getByRole('navigation', { name: 'Main' })
  await expect(nav.getByRole('button', { name: 'Chats' })).toHaveAttribute('aria-current', 'page')

  const list = page.getByRole('complementary', { name: 'Chats', exact: true })
  await expect(list.getByRole('heading', { name: 'Groups' })).toBeVisible()
  await expect(list.getByRole('heading', { name: 'Direct' })).toBeVisible()
  await expect(list.getByRole('link', { name: /Team room/ })).toHaveAttribute(
    'aria-current',
    'page',
  )
  for (const name of ['lead', 'builder', 'reviewer', 'designer'])
    await expect(list.getByRole('link', { name: new RegExp(`^${name}`) })).toBeVisible()

  await list.getByRole('link', { name: /^builder/ }).click()
  await expect(page).toHaveURL(/\/b\?with=builder$/)
  await expect(page.getByRole('complementary', { name: 'Side panel' })).toBeVisible()
  await expect(list.getByRole('link', { name: /^builder/ })).toHaveAttribute('aria-current', 'page')

  await list.getByRole('link', { name: /Team room/ }).click()
  await expect(page).toHaveURL(/\/b$/)
  await expect(page.getByRole('group', { name: 'Team room, chat header' })).toBeVisible()
})

test('the list folds into a rail, unfolds again and is remembered', async ({ page }) => {
  await pair(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/b')
  await page.getByRole('button', { name: 'Fold the chat list' }).click()
  const rail = page.getByRole('complementary', { name: 'Chats, folded' })
  await expect(rail.getByRole('link', { name: 'Team room' })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('complementary', { name: 'Chats, folded' })).toBeVisible()
  await page.getByRole('button', { name: 'Show the chat list' }).click()
  await expect(page.getByRole('complementary', { name: 'Chats', exact: true })).toBeVisible()
})

test('Chat info opens the Info tab with members and topics, and closing it gives the chat the width', async ({
  page,
}) => {
  await pair(page)
  const room = await makeRoom(page, 'chatinfo', ['lead', 'builder'])
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`/b?room=${room.id}`)
  const header = page.getByRole('group', { name: `${room.name}, chat header` })
  await expect(header).toContainText('Owner lead')
  await expect(header).toContainText('2 members')

  const info = header.getByRole('button', { name: 'Chat info' })
  await info.click()
  await expect(info).toHaveAttribute('aria-pressed', 'true')
  const panel = page.getByLabel(`${room.name}, chat info`)
  await expect(panel.getByRole('heading', { name: 'Members' })).toBeVisible()
  await expect(panel.getByText('owner', { exact: true })).toBeVisible()
  await expect(panel.getByRole('heading', { name: 'Topics' })).toBeVisible()

  const wide = (await page.locator('.roomcol').boundingBox())!.width
  await info.click()
  await expect(page.getByRole('complementary', { name: 'Side panel' })).toBeHidden()
  expect((await page.locator('.roomcol').boundingBox())!.width).toBeGreaterThan(wide)
})

test('on a phone the list is the first screen, a chat opens and Back returns', async ({ page }) => {
  await pair(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/b')
  const list = page.getByRole('complementary', { name: 'Chats', exact: true })
  await expect(list.getByRole('link', { name: /Team room/ })).toBeVisible()
  await expect(list.getByRole('button', { name: 'Fold the chat list' })).toHaveCount(0)
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible()

  await list.getByRole('link', { name: /^builder/ }).click()
  await expect(page).toHaveURL(/with=builder/)
  await page.getByRole('button', { name: 'Back', exact: true }).click()
  await expect(list).toBeVisible()

  await list.getByRole('link', { name: /Team room/ }).click()
  await page.getByRole('button', { name: 'Back to chats' }).click()
  await expect(list).toBeVisible()
})
