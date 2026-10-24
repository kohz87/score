import { expect, test, type Page } from '@playwright/test'
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

async function openOlderRoom(page: Page) {
  const picker = await openRoomPicker(page)
  await picker.getByRole('option', { name: /#activity-feed/ }).click()
  await expect(page.getByText('Older room · @name')).toBeVisible()
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
      await expect(picker).toContainText('Always on · the team’s home')
      await expect(picker).toContainText('Elsewhere · the agents’ own chats outside Score')
      await expect(picker.getByRole('option', { name: /Plan the launch checklist/ })).toContainText(
        'lead · Telegram · 4 messages',
      )
      await picker.getByRole('option', { name: /#activity-feed/ }).click()

      await expect(page).toHaveURL(/room=room-old/)
      await expect(page.locator('.roomtitle')).toHaveText(/#activity-feed/)
      await expect(page.getByText('Older room · @name')).toBeVisible()
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
      expect((await download).suggestedFilename()).toBe('room.md')

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

    test(`the job menu shares that job and exports the classic room at ${at}`, async ({ page }) => {
      const state = await openMenuRoom(page)
      await page.getByRole('tab', { name: /Activity feed/ }).click()
      await page.getByRole('button', { name: 'Job menu' }).click()
      const menu = page.getByRole('menu', { name: 'Activity feed actions' })
      await expect(menu).toHaveAttribute('data-protected', 'flex')
      await expect(menu).toContainText('Share a read-only link')
      await expect(menu).toContainText('Export this room as Markdown')
      await expect(menu).not.toContainText('Rename')
      await expect(menu).not.toContainText('Delete job')

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
      await page.getByRole('menuitem', { name: 'Export this room as Markdown' }).click()
      expect((await download).suggestedFilename()).toBe('room.md')
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
      await expect(side.locator('textarea, input:not([type="hidden"])')).toHaveCount(0)

      await side.getByRole('button', { name: 'Bring into a job' }).click()
      await expect(page).toHaveURL(/job=job-brought/)
      await expect(page.getByRole('tab', { name: /Plan the launch checklist/ })).toBeVisible()

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
  })
}
