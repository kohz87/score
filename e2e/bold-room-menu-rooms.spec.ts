import { expect, test } from '@playwright/test'
import { openMenuRoom } from './bold-room-menu-fixtures.ts'
import {
  expectOlderRoomLabel,
  forEachMenuViewport,
  menuTestOptions,
  onScreen,
  openOlderRoom,
  openRoomPicker,
  share,
} from './bold-room-menu-spec-helpers.ts'

test.use(menuTestOptions)

forEachMenuViewport((at, viewport) => {
  test(`the room dropdown opens an older room read-write and sends @builder there at ${at}`, async ({
    page,
  }) => {
    const state = await openMenuRoom(page)
    const picker = await openRoomPicker(page)
    await expect(picker).toBeVisible()
    await expect(picker).toContainText('Always on · 2 jobs')
    await expect(picker).toContainText('Elsewhere · the agents’ own chats outside Score')
    const outside = picker.getByRole('option', { name: /Plan the launch checklist/ })
    await expect(outside).toContainText('lead · Telegram')
    await expect(outside).toContainText('Plan the launch checklist · 4 messages')
    await picker.getByRole('option', { name: /#activity-feed/ }).click()

    await expect(page).toHaveURL(/room=room-old/)
    if (viewport.width > 860) await expect(page.locator('.roomtitle')).toHaveText(/#activity-feed/)
    else await expect(page.locator('[data-phone-chat-title]')).toHaveText('#activity-feed')
    await expectOlderRoomLabel(page)
    await expect(page.getByRole('button', { name: 'Start a job' })).toHaveCount(0)
    const composer = page.getByRole('combobox', { name: /^Message #activity-feed/ })
    await composer.fill('@builder Where is the cursor fix?')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(composer).toHaveValue('')

    const sent = state.requests.find(
      (request) => request.method === 'POST' && request.path === '/api/rooms/room-old/messages',
    )
    expect(sent?.body).toMatchObject({ text: '@builder Where is the cursor fix?' })
  })

  test(`an imported chat opens read-write and sends normally at ${at}`, async ({ page }) => {
    const state = await openMenuRoom(page)
    const picker = await openRoomPicker(page)
    await expect(picker).toContainText('Imported chats')
    const imported = picker.getByRole('option', { name: /#telegram-plan #imported/ })
    await expect(imported).toContainText('Imported from Telegram · read-write')
    await imported.click()

    await expect(page).toHaveURL(/room=room-imported/)
    if (viewport.width > 860)
      await expect(page.locator('.roomtitle')).toContainText('#telegram-plan #imported')
    else
      await expect(page.locator('[data-phone-chat-title]')).toHaveText('#telegram-plan #imported')
    const composer = page.getByRole('combobox', { name: /^Message #telegram-plan/ })
    await composer.fill('@builder Continue here?')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(composer).toHaveValue('')

    expect(
      state.requests.find(
        (request) =>
          request.method === 'POST' && request.path === '/api/rooms/room-imported/messages',
      )?.body,
    ).toMatchObject({ text: '@builder Continue here?' })
    expect(state.requests.some((request) => request.path.endsWith('/continue-session'))).toBe(false)
  })

  test(`the room dropdown works from the keyboard at ${at}`, async ({ page }) => {
    await openMenuRoom(page)
    const trigger = page.getByRole('button', { name: 'Room menu' })
    await openRoomPicker(page)
    const picker = page.getByRole('listbox', { name: 'Rooms and chats elsewhere' })
    const team = picker.getByRole('option', { name: /Team room/ })
    const older = picker.getByRole('option', { name: /#activity-feed/ })
    const outside = picker.getByRole('option', { name: /Plan the launch checklist/ })

    await expect(team).toBeFocused()
    await expect(team).toHaveAttribute('aria-selected', 'true')
    await page.keyboard.press('ArrowDown')
    await expect(older).toBeFocused()
    await expect(older).toHaveAttribute('aria-selected', 'false')
    await page.keyboard.press('Escape')
    await expect(picker).toHaveCount(0)
    await expect(trigger).toBeFocused()

    await openRoomPicker(page)
    await expect(team).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(older).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/room=room-old/)
    if (viewport.width <= 860) {
      await expect(page.locator('[data-phone-chat-title]')).toBeFocused()
      return
    }
    await expect(trigger).toBeFocused()

    await openRoomPicker(page)
    await expect(outside).toBeVisible()
    await expect(team).toBeFocused() // the menu's first-focus has landed
    await page.keyboard.press('End')
    await expect(outside).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(picker).toHaveCount(0)
  })

  test(`the room menu exports, shares a read-only link and deletes an older room with confirmation at ${at}`, async ({
    page,
  }) => {
    const state = await openMenuRoom(page)
    await openOlderRoom(page)

    await page.getByRole('button', { name: 'Room menu' }).click()
    const menu = page.getByRole('menu', { name: '#activity-feed actions' })
    await expect(menu).toHaveAttribute('data-protected', 'flex')
    await expect(menu).toContainText('Export this room')
    await expect(menu).toContainText('Share a read-only link')
    await expect(menu).toContainText('Delete #activity-feed')
    await onScreen(page, menu)

    const download = page.waitForEvent('download')
    await menu.getByRole('menuitem', { name: 'Export this room' }).click()
    const dl = await download
    // Browser downloads bypass page.route, so the name is the server's; the link's target is what we own.
    expect(new URL(dl.url()).pathname).toBe('/api/rooms/room-old/export.md')

    await page.getByRole('button', { name: 'Room menu' }).click()
    await page.getByRole('menuitem', { name: 'Share a read-only link' }).click()
    await share(page, '#activity-feed')
    expect(
      state.requests.find(
        (request) => request.method === 'POST' && request.path === '/api/rooms/room-old/shares',
      )?.body,
    ).toMatchObject({ password: 'correct horse', expiresInDays: 7 })

    await page.getByRole('button', { name: 'Room menu' }).click()
    await page.getByRole('menuitem', { name: 'Delete #activity-feed' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('heading', { name: 'Delete #activity-feed?' })).toBeVisible()
    await expect(dialog).toHaveAttribute('data-protected', 'any')
    await expect(dialog).toContainText('1 message')
    await dialog.getByLabel(/Type #activity-feed to confirm/).fill('#activity-feed')
    await dialog.getByRole('button', { name: 'Delete room' }).click()

    await expect(page).toHaveURL(/\/b(\?open=1)?$/)
    // 3.24.0: a phone opened the chat as `/b?open=1`, so after a delete it stays in the team room's conversation
    // (before, the test entered through the retired list screen and fell back to the chat list).
    if (viewport.width > 860) await expect(page.locator('.roomtitle')).toHaveText('Team room')
    else await expect(page.locator('[data-phone-chat-title]')).toHaveText('Team room')
    expect(
      state.requests.some(
        (request) => request.method === 'DELETE' && request.path === '/api/rooms/room-old',
      ),
    ).toBe(true)
  })

  test(`an imported chat can be deleted with the same typed confirmation at ${at}`, async ({
    page,
  }) => {
    const state = await openMenuRoom(page)
    const picker = await openRoomPicker(page)
    await picker.getByRole('option', { name: /#telegram-plan #imported/ }).click()
    await expect(page).toHaveURL(/room=room-imported/)

    await page.getByRole('button', { name: 'Room menu' }).click()
    await page.getByRole('menuitem', { name: 'Delete #telegram-plan #imported' }).click()
    const dialog = page.getByRole('dialog')
    await expect(
      dialog.getByRole('heading', { name: 'Delete #telegram-plan #imported?' }),
    ).toBeVisible()
    await expect(dialog).toContainText('2 messages')
    await dialog
      .getByLabel(/Type #telegram-plan #imported to confirm/)
      .fill('#telegram-plan #imported')
    await dialog.getByRole('button', { name: 'Delete room' }).click()

    await expect(page).toHaveURL(/\/b(\?open=1)?$/)
    // 3.24.0: a phone opened the chat as `/b?open=1`, so after a delete it stays in the team room's conversation
    // (before, the test entered through the retired list screen and fell back to the chat list).
    if (viewport.width > 860) await expect(page.locator('.roomtitle')).toHaveText('Team room')
    else await expect(page.locator('[data-phone-chat-title]')).toHaveText('Team room')
    expect(
      state.requests.some(
        (request) => request.method === 'DELETE' && request.path === '/api/rooms/room-imported',
      ),
    ).toBe(true)
  })
})
