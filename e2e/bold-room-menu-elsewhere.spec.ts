import { expect, test } from '@playwright/test'
import { openMenuRoom } from './bold-room-menu-fixtures.ts'
import {
  forEachMenuViewport,
  menuTestOptions,
  openRoomPicker,
  topicHead,
} from './bold-room-menu-spec-helpers.ts'

test.use(menuTestOptions)

forEachMenuViewport((at, viewport) => {
  test(`Elsewhere is read-only and brings the chat into a team job with it attached at ${at}`, async ({
    page,
  }) => {
    const state = await openMenuRoom(page)
    const picker = await openRoomPicker(page)
    await picker.getByRole('option', { name: /Plan the launch checklist/ }).click()

    const side = page.getByRole('complementary', { name: 'Side panel' })
    await expect(side).toBeVisible()
    await expect(side.getByText(/From Telegram · read-only/)).toBeVisible()
    await expect(side.getByRole('heading', { name: 'Plan the launch checklist' })).toBeVisible()
    await expect(side).toContainText('4 messages')
    await expect(
      side.locator('.bold-elsewhere').locator('textarea, input:not([type="hidden"])'),
    ).toHaveCount(0)

    await side.getByRole('button', { name: 'Preview this chat' }).click()
    await expect(side.getByText('Outline the launch checklist.')).toBeVisible()
    await expect(side.getByText('Freeze the release branch, test, then announce.')).toBeVisible()
    await expect(side.getByText(/Read-only preview · from Telegram/)).toBeVisible()
    await expect(side).toContainText('It also adds an “Imported from Telegram” room')
    // 3.5.0: previewing imports nothing; only Bring does.
    expect(
      state.requests.filter(
        (request) => request.method === 'POST' && request.path === '/api/outside-sessions/import',
      ),
    ).toHaveLength(0)
    await expect(
      side.locator('.bold-elsewhere').locator('textarea, input:not([type="hidden"])'),
    ).toHaveCount(0)

    await side.getByRole('button', { name: 'Bring into a job' }).click()
    await expect(page).toHaveURL(/job=job-brought/)
    if (viewport.width > 860)
      await expect(topicHead(page, 'Plan the launch checklist')).toBeVisible()
    else {
      await expect(page.getByRole('button', { name: 'Back to chats' })).toBeVisible()
      await expect(page.locator('.bold-chat-phone-id')).toContainText('Plan the launch checklist')
    }

    expect(
      state.requests.filter(
        (request) => request.method === 'POST' && request.path === '/api/outside-sessions/import',
      ),
    ).toHaveLength(1)
    expect(
      state.requests.find(
        (request) => request.method === 'POST' && request.path === '/api/outside-sessions/import',
      )?.body,
    ).toEqual({ agentId: 'lead', sessionId: 'ext-telegram-1' })
    expect(
      state.requests.find(
        (request) => request.method === 'POST' && request.path === '/api/rooms/team-room/jobs',
      )?.body,
    ).toEqual({ title: 'Plan the launch checklist' })
    expect(
      state.requests.filter(
        (request) => request.method === 'POST' && request.path.startsWith('/api/messages/import'),
      ),
    ).toHaveLength(2)
  })

  test(`a failed share is retried with the same job, a new key and no duplicate copies at ${at}`, async ({
    page,
  }) => {
    const state = await openMenuRoom(page, { failShare: 2 })
    const picker = await openRoomPicker(page)
    await picker.getByRole('option', { name: /Plan the launch checklist/ }).click()
    const side = page.getByRole('complementary', { name: 'Side panel' })
    await side.getByRole('button', { name: 'Preview this chat' }).click()
    await expect(side.getByText('Outline the launch checklist.')).toBeVisible()

    await side.getByRole('button', { name: 'Bring into a job' }).click()
    await expect(side.getByRole('alert')).toContainText(
      'Couldn’t bring this chat into a job. Try again',
    )
    await side.getByRole('button', { name: 'Bring into a job' }).click()
    await expect(page).toHaveURL(/job=job-brought/)

    const writes = state.requests
      .filter(
        (request) =>
          request.method === 'POST' &&
          (request.path === '/api/outside-sessions/import' ||
            request.path === '/api/rooms/team-room/jobs' ||
            request.path.endsWith('/share')),
      )
      .map((request) => request.path)
    expect(writes).toEqual([
      '/api/outside-sessions/import',
      '/api/rooms/team-room/jobs',
      '/api/messages/import%3A1/share',
      '/api/messages/import%3A2/share',
      '/api/messages/import%3A2/share',
    ])
    expect(writes.filter((path) => path === '/api/rooms/team-room/jobs')).toHaveLength(1)
    const writesWithKeys = state.requests.filter(
      (request) =>
        request.method === 'POST' &&
        (request.path === '/api/rooms/team-room/jobs' || request.path.endsWith('/share')),
    )
    const keys = writesWithKeys.map((request) => request.headers['idempotency-key'])
    expect(keys.every(Boolean)).toBe(true)
    expect(new Set(keys).size).toBe(writesWithKeys.length)
    // The failed call and its retry are different HTTP calls, so they must not share a key.
    const secondShare = writesWithKeys.filter(
      (request) => request.path === '/api/messages/import%3A2/share',
    )
    expect(secondShare).toHaveLength(2)
    expect(secondShare[0]!.headers['idempotency-key']).not.toBe(
      secondShare[1]!.headers['idempotency-key'],
    )
  })

  test(`closing the panel mid-way keeps the attempt, and a retry makes one job at ${at}`, async ({
    page,
  }) => {
    const state = await openMenuRoom(page, { failShare: 2 })
    const picker = await openRoomPicker(page)
    await picker.getByRole('option', { name: /Plan the launch checklist/ }).click()
    const side = page.getByRole('complementary', { name: 'Side panel' })
    await side.getByRole('button', { name: 'Preview this chat' }).click()
    await expect(side.getByText('Outline the launch checklist.')).toBeVisible()
    await side.getByRole('button', { name: 'Bring into a job' }).click()
    await expect(side.getByRole('alert')).toContainText('kept while this page is open')

    if (viewport.width > 860) {
      // 3.22.0: the panel has no mode button; the header's Chat info brings Info back over the Elsewhere view.
      await page.getByRole('button', { name: 'Chat info' }).click()
      await expect(page.getByRole('tab', { name: 'Info' })).toBeVisible()
    } else {
      await side.getByRole('button', { name: 'Close side panel' }).click()
    }
    const reopened = page.getByRole('complementary', { name: 'Side panel' })
    await (
      await openRoomPicker(page)
    )
      .getByRole('option', { name: /Plan the launch checklist/ })
      .click()
    // On a phone the closed sheet keeps the view (and its loaded preview); on a desktop the view remounts, which is
    // the case the kept attempt is for.
    const preview = reopened.getByRole('button', { name: 'Preview this chat' })
    if (await preview.isVisible()) await preview.click()
    await expect(reopened.getByText('Outline the launch checklist.')).toBeVisible()
    await reopened.getByRole('button', { name: 'Bring into a job' }).click()
    await expect(page).toHaveURL(/job=job-brought/)

    expect(
      state.requests.filter(
        (request) => request.method === 'POST' && request.path === '/api/rooms/team-room/jobs',
      ),
    ).toHaveLength(1)
    expect(
      state.requests.filter(
        (request) => request.method === 'POST' && request.path === '/api/messages/import%3A1/share',
      ),
    ).toHaveLength(1)
    expect(
      state.requests.filter(
        (request) => request.method === 'POST' && request.path === '/api/messages/import%3A2/share',
      ),
    ).toHaveLength(2)
  })
})
