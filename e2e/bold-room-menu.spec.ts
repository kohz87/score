import { expect, test, type Page } from '@playwright/test'
import { openBoldJob } from './bold-room-fixtures.ts'
import { openMenuRoom } from './bold-room-menu-fixtures.ts'

test.use({
  reducedMotion: 'reduce',
  permissions: ['clipboard-read', 'clipboard-write'],
})

const sizes = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
] as const

async function openRoomPicker(page: Page) {
  await page.locator('.roomtitle').click()
  return page.getByRole('listbox', { name: 'Rooms and chats elsewhere' })
}

// The app's phone composer hides the "to" chip (bold-room.css); the label stays in the DOM.
async function expectOlderRoomLabel(page: Page) {
  const label = page.getByText('Older room · @name')
  if ((page.viewportSize()?.width ?? 0) > 600) await expect(label).toBeVisible()
  else {
    await expect(page.locator('[data-phone-chat-title]')).toHaveText('#activity-feed')
    await expect(page.getByRole('button', { name: 'Back to the team room' })).toBeVisible()
    await expect(label).toBeAttached()
  }
}

async function openOlderRoom(page: Page) {
  const picker = await openRoomPicker(page)
  await picker.getByRole('option', { name: /#activity-feed/ }).click()
  await expectOlderRoomLabel(page)
  await expect(page.getByRole('button', { name: 'Start a job' })).toHaveCount(0)
}

async function share(page: Page, title: string) {
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: `Share ${title}` })).toBeVisible()
  await expect(dialog).toHaveAttribute('data-protected', 'any')
  await dialog.getByLabel('Security password').fill('correct horse')
  await dialog.getByRole('button', { name: 'Create link' }).click()
  await expect(dialog.getByText('https://score.lan/s/ROOM-MENU')).toBeVisible()
  await dialog.getByRole('button', { name: 'Close' }).click()
}

for (const viewport of sizes) {
  const at = `${viewport.width}×${viewport.height}`

  test.describe(at, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize(viewport)
    })

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
      if (viewport.width > 860)
        await expect(page.locator('.roomtitle')).toHaveText(/#activity-feed/)
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
      expect(state.requests.some((request) => request.path.endsWith('/continue-session'))).toBe(
        false,
      )
    })

    test(`the room dropdown works from the keyboard at ${at}`, async ({ page }) => {
      await openMenuRoom(page)
      const trigger = page.locator('.roomtitle')
      await trigger.click()
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

      await trigger.click()
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

      await trigger.click()
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

      await expect(page).toHaveURL(/\/b$/)
      await expect(page.locator('.roomtitle')).toHaveText('Team room')
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

      await expect(page).toHaveURL(/\/b$/)
      await expect(page.locator('.roomtitle')).toHaveText('Team room')
      expect(
        state.requests.some(
          (request) => request.method === 'DELETE' && request.path === '/api/rooms/room-imported',
        ),
      ).toBe(true)
    })

    test(`the job menu shares that job and exports the classic room at ${at}`, async ({ page }) => {
      const state = await openMenuRoom(page)
      await openBoldJob(page, /Activity feed/)
      await page.getByRole('button', { name: 'Job menu' }).click()
      const menu = page.getByRole('menu', { name: 'Activity feed actions' })
      await expect(menu).toHaveAttribute('data-protected', 'flex')
      await expect(menu).toContainText('Rename…')
      await expect(menu).toContainText('Close')
      await expect(menu).toContainText('Share a read-only link')
      await expect(menu).toContainText('Export the whole room as Markdown')
      await expect(menu).toContainText('Delete job')

      await menu.getByRole('menuitem', { name: 'Share a read-only link' }).click()
      await share(page, 'Activity feed')
      expect(
        state.requests.find(
          (request) => request.method === 'POST' && request.path === '/api/rooms/team-room/shares',
        )?.body,
      ).toMatchObject({
        password: 'correct horse',
        jobId: 'job-activity',
      })

      await page.getByRole('button', { name: 'Job menu' }).click()
      const download = page.waitForEvent('download')
      await page.getByRole('menuitem', { name: 'Export the whole room as Markdown' }).click()
      expect(new URL((await download).url()).pathname).toMatch(/^\/api\/rooms\/[^/]+\/export\.md$/)
    })

    test(`rename, close and reopen a job from its menu at ${at}`, async ({ page }) => {
      let jobs = [
        {
          id: 'job-activity',
          roomId: 'team-room',
          title: 'Activity feed',
          state: 'working',
          holderAgentId: 'builder',
          isDefault: false,
          exchangeBudget: 8,
          jobTurnLimit: 40,
          unread: 0,
          activeAgents: [],
          lastMessageAt: null,
          messageCount: 0,
          summary: null,
          source: null,
          reportBack: null,
          spendCapUsd: null,
          recipe: null,
          createdAt: '2026-10-24T10:00:00.000Z',
          updatedAt: '2026-10-24T10:15:00.000Z',
        },
      ]
      const state = await openMenuRoom(page, {
        handle: (request) => {
          const item = jobs[0]!
          if (request.method === 'PATCH' && request.path === '/api/jobs/job-activity') {
            const body = request.body as { title?: string }
            jobs = [{ ...item, title: body.title ?? item.title }]
            return { body: jobs[0] }
          }
          if (request.method === 'POST' && request.path === '/api/jobs/job-activity/close') {
            jobs = [{ ...item, state: 'closed' }]
            return { body: jobs[0] }
          }
          if (request.method === 'POST' && request.path === '/api/jobs/job-activity/reopen') {
            jobs = [{ ...item, state: 'open' }]
            return { body: jobs[0] }
          }
          return undefined
        },
      })
      await openBoldJob(page, /Activity feed/)
      await page.getByRole('button', { name: 'Job menu' }).click()
      await page.getByRole('menuitem', { name: 'Rename…' }).click()
      const dialog = page.getByRole('dialog')
      await expect(dialog).toHaveAttribute('data-protected', 'any')
      await dialog.getByLabel('Name').fill('Activity feed v2')
      await dialog.getByRole('button', { name: 'Rename' }).click()
      await expect(page.getByRole('status').filter({ hasText: 'Renamed' })).toBeVisible()
      if (viewport.width > 860)
        await expect(page.getByRole('tab', { name: /Activity feed v2/ })).toBeVisible()
      else await expect(page.locator('[data-phone-chat-title]')).toHaveText('Activity feed v2')
      expect(
        state.requests.find(
          (request) => request.method === 'PATCH' && request.path === '/api/jobs/job-activity',
        )?.body,
      ).toEqual({ title: 'Activity feed v2' })

      await page.getByRole('button', { name: 'Job menu' }).click()
      await page.getByRole('menuitem', { name: 'Close' }).click()
      await expect(
        page.getByRole('status').filter({ hasText: 'Closed “Activity feed v2”' }),
      ).toBeVisible()
      if (viewport.width > 860) {
        await expect(page.getByRole('tab', { name: /Activity feed v2/ })).toHaveCount(0)
        await page.getByRole('button', { name: 'Closed jobs', exact: true }).click()
        await expect(page.getByRole('tab', { name: /Activity feed v2/ })).toBeVisible()
        await page.getByRole('tab', { name: /Activity feed v2/ }).click()
      } else {
        await expect(page.getByRole('button', { name: /^Activity feed v2\./ })).toHaveCount(0)
        await page.getByRole('button', { name: 'Closed jobs (2)' }).click()
        await page.getByRole('button', { name: /^Activity feed v2\./ }).click()
      }
      await page.getByRole('button', { name: 'Job menu' }).click()
      await page.getByRole('menuitem', { name: 'Reopen' }).click()
      await expect(
        page.getByRole('status').filter({ hasText: 'Reopened “Activity feed v2”' }),
      ).toBeVisible()
    })

    test(`delete asks for the typed title and offers Undo at ${at}`, async ({ page }) => {
      const state = await openMenuRoom(page, {
        handle: (request) => {
          if (request.method === 'DELETE' && request.path === '/api/jobs/job-activity')
            return { status: 204, body: null }
          if (request.method === 'POST' && request.path === '/api/jobs/job-activity/restore')
            return {
              body: {
                id: 'job-activity',
                roomId: 'team-room',
                title: 'Activity feed',
                state: 'working',
                holderAgentId: 'builder',
                isDefault: false,
                exchangeBudget: 8,
                jobTurnLimit: 40,
                unread: 0,
                activeAgents: [],
                lastMessageAt: null,
                messageCount: 0,
                summary: null,
                source: null,
                reportBack: null,
                spendCapUsd: null,
                recipe: null,
                createdAt: '2026-10-24T10:00:00.000Z',
                updatedAt: '2026-10-24T10:15:00.000Z',
              },
            }
          return undefined
        },
      })
      await openBoldJob(page, /Activity feed/)
      await page.getByRole('button', { name: 'Job menu' }).click()
      await page.getByRole('menuitem', { name: 'Delete job' }).click()
      const dialog = page.getByRole('dialog')
      await expect(dialog).toHaveAttribute('data-protected', 'any')
      await dialog.getByLabel(/Type Activity feed to confirm/).fill('Activity feed')
      await dialog.getByRole('button', { name: 'Delete job' }).click()
      const undo = page.getByRole('status').filter({ hasText: 'Job deleted' })
      await expect(undo).toBeVisible()
      if (viewport.width > 860)
        await expect(page.getByRole('tab', { name: /Activity feed/ })).toHaveCount(0)
      else await expect(page.getByRole('button', { name: /^Activity feed\./ })).toHaveCount(0)
      await undo.getByRole('button', { name: 'Undo' }).click()
      await expect(
        page.getByRole('status').filter({ hasText: 'Restored “Activity feed”' }),
      ).toBeVisible()
      if (viewport.width > 860)
        await expect(page.getByRole('tab', { name: /Activity feed/ })).toBeVisible()
      else await expect(page.getByRole('button', { name: /^Activity feed\./ })).toBeVisible()
      expect(
        state.requests.some(
          (request) =>
            request.method === 'POST' && request.path === '/api/jobs/job-activity/restore',
        ),
      ).toBe(true)
    })

    test(`a closed job survives a reload under Closed jobs at ${at}`, async ({ page }) => {
      await openMenuRoom(page)
      await page.reload()
      await expect(page.locator('[data-ui="bold"] .top .word')).toBeVisible({ timeout: 20_000 })
      if (viewport.width > 860) {
        await page.getByRole('button', { name: 'Closed jobs', exact: true }).click()
        await expect(page.getByRole('tab', { name: /Old import/ })).toBeVisible()
      } else {
        await page.getByRole('button', { name: 'Closed jobs (1)' }).click()
        await expect(page.getByRole('button', { name: /^Old import\./ })).toBeVisible()
      }
    })

    test(`Undo survives leaving the room at ${at}`, async ({ page }) => {
      const state = await openMenuRoom(page, {
        handle: (request) => {
          if (request.method === 'DELETE' && request.path === '/api/jobs/job-activity')
            return { status: 204, body: null }
          if (request.method === 'POST' && request.path === '/api/jobs/job-activity/restore')
            return {
              body: {
                id: 'job-activity',
                roomId: 'team-room',
                title: 'Activity feed',
                state: 'working',
                holderAgentId: 'builder',
                isDefault: false,
                exchangeBudget: 8,
                jobTurnLimit: 40,
                unread: 0,
                activeAgents: [],
                lastMessageAt: null,
                messageCount: 0,
                summary: null,
                source: null,
                reportBack: null,
                spendCapUsd: null,
                recipe: null,
                createdAt: '2026-10-24T10:00:00.000Z',
                updatedAt: '2026-10-24T10:15:00.000Z',
              },
            }
          return undefined
        },
      })
      await openBoldJob(page, /Activity feed/)
      await page.getByRole('button', { name: 'Job menu' }).click()
      await page.getByRole('menuitem', { name: 'Delete job' }).click()
      const dialog = page.getByRole('dialog')
      await dialog.getByLabel(/Type Activity feed to confirm/).fill('Activity feed')
      await dialog.getByRole('button', { name: 'Delete job' }).click()
      await page.getByRole('button', { name: 'Team', exact: true }).click()
      const undo = page.getByRole('status').filter({ hasText: 'Job deleted' })
      await expect(undo).toBeVisible()
      await undo.getByRole('button', { name: 'Undo' }).click()
      await expect(
        page.getByRole('status').filter({ hasText: 'Restored “Activity feed”' }),
      ).toBeVisible()
      expect(
        state.requests.some(
          (request) =>
            request.method === 'POST' && request.path === '/api/jobs/job-activity/restore',
        ),
      ).toBe(true)
    })

    test(`the job menu works from the keyboard at ${at}`, async ({ page }) => {
      await openMenuRoom(page)
      await openBoldJob(page, /Activity feed/)
      const trigger = page.getByRole('button', { name: 'Job menu' })
      await trigger.click()
      const menu = page.getByRole('menu', { name: 'Activity feed actions' })
      const renameItem = menu.getByRole('menuitem', { name: 'Rename…' })
      const closeItem = menu.getByRole('menuitem', { name: 'Close' })
      const shareItem = menu.getByRole('menuitem', { name: 'Share a read-only link' })
      const exportItem = menu.getByRole('menuitem', { name: 'Export the whole room as Markdown' })

      await expect(renameItem).toBeFocused()
      await page.keyboard.press('ArrowDown')
      await expect(closeItem).toBeFocused()
      await page.keyboard.press('ArrowDown')
      await expect(shareItem).toBeFocused()
      await page.keyboard.press('ArrowDown')
      await expect(exportItem).toBeFocused()
      await page.keyboard.press('ArrowUp')
      await expect(shareItem).toBeFocused()
      await page.keyboard.press('Escape')
      await expect(menu).toHaveCount(0)
      await expect(trigger).toBeFocused()
    })

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
      await expect(side.getByText(/Read-only preview · imported from Telegram/)).toBeVisible()
      await expect(side).toContainText('It also keeps the “Imported from Telegram” room')
      await expect(
        side.locator('.bold-elsewhere').locator('textarea, input:not([type="hidden"])'),
      ).toHaveCount(0)

      await side.getByRole('button', { name: 'Bring into a job' }).click()
      await expect(page).toHaveURL(/job=job-brought/)
      if (viewport.width > 860)
        await expect(page.getByRole('tab', { name: /Plan the launch checklist/ })).toBeVisible()
      else {
        await expect(page.getByRole('button', { name: 'Back to jobs' })).toBeVisible()
        await expect(page.locator('.bold-phone-chat-id')).toContainText('Plan the launch checklist')
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
        // The side panel's mode button names the chat while Elsewhere is open; its menu switches back to Work.
        await side.locator('.side-toggle').click()
        await side.getByRole('button', { name: /^Work/ }).click()
      } else {
        await side.getByRole('button', { name: 'Close side panel' }).click()
      }
      const reopened = page.getByRole('complementary', { name: 'Side panel' })
      await page.locator('.roomtitle').click()
      await page
        .getByRole('listbox', { name: 'Rooms and chats elsewhere' })
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
          (request) =>
            request.method === 'POST' && request.path === '/api/messages/import%3A1/share',
        ),
      ).toHaveLength(1)
      expect(
        state.requests.filter(
          (request) =>
            request.method === 'POST' && request.path === '/api/messages/import%3A2/share',
        ),
      ).toHaveLength(2)
    })
  })
}
