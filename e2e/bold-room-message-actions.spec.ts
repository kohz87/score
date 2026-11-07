import { expect, test } from '@playwright/test'
import { openBoldRoom } from './bold-room-fixtures.ts'
import { forEachRoomViewport, message, openJob, roomTestOptions } from './bold-room-spec-helpers.ts'

test.use(roomTestOptions)

forEachRoomViewport((at, viewport) => {
  test(`the hover row copies, saves, and pins or unpins at ${at}`, async ({ page }) => {
    const state = await openBoldRoom(page)
    // 3.24.0: no job screen on a phone; the one conversation already holds every topic's messages.
    if (viewport.width <= 860) await expect(message(page, 'message-pinned')).toBeVisible()
    const pinned = message(page, 'message-pinned')
    await pinned.hover()
    await expect(pinned.getByRole('button', { name: 'Unpin message from reviewer' })).toBeVisible()
    await pinned.getByRole('button', { name: 'Unpin message from reviewer' }).click()
    await expect(pinned.getByRole('button', { name: 'Pin message from reviewer' })).toBeVisible()
    expect(
      state.requests.some(
        (request) =>
          request.method === 'DELETE' &&
          request.path === '/api/rooms/team-room/pins/message-pinned',
      ),
    ).toBe(true)
    await pinned.getByRole('button', { name: 'Pin message from reviewer' }).click()
    await expect(pinned.getByRole('button', { name: 'Unpin message from reviewer' })).toBeVisible()
    expect(
      state.requests.some(
        (request) =>
          request.method === 'POST' && request.path === '/api/rooms/team-room/pins/message-pinned',
      ),
    ).toBe(true)

    if (viewport.width <= 860) await page.getByRole('button', { name: 'Back to chats' }).click()
    await openJob(page, /Activity feed/)
    const builder = message(page, 'message-builder')
    await builder.hover()
    await builder.getByRole('button', { name: 'Copy message from builder' }).click()
    await expect(builder.getByRole('button', { name: 'Copy message from builder' })).toHaveText(
      'Copied',
    )
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      'Read layer is ready. The feed renders newest first.',
    )

    await builder.hover()
    await builder.getByRole('button', { name: 'Save message from builder to Library' }).click()
    const save = page.getByRole('dialog', { name: 'Save to Knowledge' })
    await expect(save.getByText('This reply as a note')).toBeVisible()
    await save.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(save.getByRole('status')).toContainText(/Added inbox\/Reply from builder .*\.md/)
    expect(
      state.requests.some(
        (request) =>
          request.method === 'PUT' &&
          decodeURIComponent(request.path).startsWith(
            '/api/knowledge/files/inbox/Reply from builder',
          ),
      ),
    ).toBe(true)
    await save.getByRole('button', { name: 'Done' }).click()
  })

  test(`edit rewinds then sends the correction at ${at}`, async ({ page }) => {
    const state = await openBoldRoom(page)
    await openJob(page, /Activity feed/)
    const own = message(page, 'message-action')
    await own.hover()
    await own.getByRole('button', { name: 'Edit message from You' }).click()
    const composer = page.getByRole('combobox', { name: /^Message Team room/ })
    await expect(composer).toHaveValue('Please add pagination.')
    await expect(page.getByText(/Sending replaces it and rewinds/)).toBeVisible()
    await composer.fill('Please add pagination, newest first.')
    await page.getByRole('button', { name: 'Send correction', exact: true }).click()

    // 2.0.12: Send rewinds and posts by itself when every agent can be rewound.
    await expect(page.getByRole('dialog', { name: 'Edit and send again?' })).toHaveCount(0)

    await expect
      .poll(() =>
        state.requests.find(
          (request) =>
            request.method === 'POST' && request.path === '/api/rooms/team-room/messages',
        ),
      )
      .toBeTruthy()
    expect(
      state.requests.find(
        (request) => request.method === 'POST' && request.path === '/api/rooms/team-room/messages',
      )?.body,
    ).toMatchObject({ edits: 'message-action', text: 'Please add pagination, newest first.' })
    expect(
      state.requests.some(
        (request) =>
          request.method === 'POST' &&
          request.path === '/api/rooms/team-room/messages/message-action/rewind',
      ),
    ).toBe(true)
  })

  test(`delete opens the rewind dialog and the toggle reveals deleted history at ${at}`, async ({
    page,
  }) => {
    const state = await openBoldRoom(page)
    await openJob(page, /Activity feed/)
    const own = message(page, 'message-activity')
    await own.hover()
    await own.getByRole('button', { name: 'Delete message from You' }).click()
    const dialog = page.getByRole('dialog', { name: 'Delete this message?' })
    await expect(dialog.getByText(/2 messages \(this one and everything after it\)/)).toBeVisible()
    await dialog.getByRole('button', { name: 'Rewind and delete' }).click()
    await expect
      .poll(() =>
        state.requests.find(
          (request) =>
            request.method === 'POST' &&
            request.path === '/api/rooms/team-room/messages/message-activity/rewind',
        ),
      )
      .toBeTruthy()

    await expect(page.getByText('Old plan we replaced.')).toHaveCount(0)
    // 3.22.0: "Show deleted messages" moved into the room menu.
    await page.getByRole('button', { name: 'Room menu' }).click()
    await page.getByRole('menuitemcheckbox', { name: 'Show deleted messages' }).click()
    const deleted = page.getByRole('region', { name: 'Deleted messages' })
    await expect(deleted).toContainText('Deleted, read-only. 2 hidden messages.')
    await expect(deleted.getByText('Old plan we replaced.')).toBeVisible()
    await page.getByRole('button', { name: 'Room menu' }).click()
    await page.getByRole('menuitemcheckbox', { name: 'Hide deleted messages' }).click()
    await expect(deleted).toHaveCount(0)
  })

  test(`versions step from ‹ 3 / 3 › to 2 / 3 and 1 / 3 at ${at}`, async ({ page }) => {
    await openBoldRoom(page)
    await openJob(page, /Activity feed/)
    const edited = message(page, 'message-edit')
    const control = edited.getByRole('group', { name: 'Message versions' })
    await expect(control).toContainText('Version 3 of 3')
    await control.getByRole('button', { name: 'Previous version' }).click()
    await expect(page.getByRole('region', { name: 'Version 2 of 3' })).toBeVisible()
    await expect(page.getByText('Make the cursor stable, second wording.')).toBeVisible()
    await page
      .getByRole('region', { name: 'Version 2 of 3' })
      .getByRole('button', { name: 'Previous version' })
      .click()
    await expect(page.getByRole('region', { name: 'Version 1 of 3' })).toBeVisible()
    await expect(page.getByText('Make the cursor stable, first wording.')).toBeVisible()
    await page.getByRole('button', { name: 'Back to latest' }).click()
    await expect(page.getByRole('region', { name: /^Version [12] of 3$/ })).toHaveCount(0)
  })
})
