import { expect, test } from '@playwright/test'
import { openBoldJob, openBoldRoom } from './bold-room-fixtures.ts'
import { forEachRoomViewport, roomTestOptions } from './bold-room-spec-helpers.ts'

test.use(roomTestOptions)

forEachRoomViewport((at) => {
  test(`@name sends to that agent in the selected job at ${at}`, async ({ page }) => {
    const state = await openBoldRoom(page)
    await openBoldJob(page, /Release notes 2\.4/)

    const composer = page.getByRole('combobox', { name: /^Message Team room/ })
    await composer.fill('@rev')
    await page
      .getByRole('listbox', { name: 'Agents' })
      .getByRole('option', { name: /@reviewer/ })
      .click()
    await expect(composer).toHaveValue('@reviewer ')
    await composer.pressSequentially('Please check the migration steps.')
    await page.getByRole('button', { name: 'Send', exact: true }).click()

    await expect(composer).toHaveValue('')
    const sent = state.requests.find(
      (request) => request.method === 'POST' && request.path === '/api/rooms/team-room/messages',
    )
    // The @mention travels in the text: the server merges it with any explicit To chips (contract), so no `to` here.
    expect(sent?.body).toMatchObject({
      jobId: 'job-notes',
      text: '@reviewer Please check the migration steps.',
    })
    expect(sent?.body).not.toHaveProperty('to')
  })

  test(`+ attaches a file with visible progress and sends it at ${at}`, async ({ page }) => {
    const state = await openBoldRoom(page, { uploadDelay: 900 })
    await page.getByRole('button', { name: 'Attach, voice and commands' }).click()
    const menu = page.getByRole('list', { name: 'Attach, voice and commands' })
    await expect(menu.getByRole('button', { name: 'Upload files…' })).toBeVisible()
    const chooser = page.waitForEvent('filechooser')
    await menu.getByRole('button', { name: 'Upload files…' }).click()
    await (
      await chooser
    ).setFiles({
      name: 'notes.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('Release notes draft'),
    })

    const progress = page.locator('.upload-progress-compact')
    await expect(progress).toContainText('notes.txt')
    await expect(progress.locator('progress')).toBeVisible()
    const attachments = page.getByRole('list', { name: 'Attachments' })
    await expect(attachments.getByText('notes.txt')).toBeVisible()
    await page.getByRole('combobox', { name: /^Message Team room/ }).fill('Here is the draft.')
    await page.getByRole('button', { name: 'Send', exact: true }).click()

    const sent = state.requests.find(
      (request) => request.method === 'POST' && request.path === '/api/rooms/team-room/messages',
    )
    expect(sent?.body).toMatchObject({
      text: 'Here is the draft.',
      attachments: [{ mediaId: 'media-notes', name: 'notes.txt' }],
    })
    await expect(attachments).toHaveCount(0)
  })

  test(`the slash menu runs an /assign command at ${at}`, async ({ page }) => {
    const state = await openBoldRoom(page)
    const composer = page.getByRole('combobox', { name: /^Message Team room/ })
    await composer.fill('/')
    const commands = page.getByRole('listbox', { name: 'Commands' })
    await expect(commands.getByRole('option', { name: /^\/assign/ })).toBeVisible()
    await composer.press('Enter')
    await expect(composer).toHaveValue('/assign ')

    await composer.pressSequentially('Audit the release notes')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    const status = page.getByRole('status').filter({ hasText: 'Created task' })
    await expect(status).toContainText('OPS-1')
    expect(
      state.requests.find(
        (request) => request.method === 'POST' && request.path === '/api/rooms/team-room/messages',
      )?.body,
    ).toMatchObject({ text: '/assign Audit the release notes' })
  })

  test(`a fresh team room shows board 09 and its starters fill the composer at ${at}`, async ({
    page,
  }) => {
    await openBoldRoom(page, { empty: true })
    await expect(
      page.getByRole('heading', { name: 'Your team is ready. What first?' }),
    ).toBeVisible()
    await expect(page.getByRole('tablist', { name: 'Jobs' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: /Build something, reviewed/ })).toBeVisible()
    await expect(page.getByRole('button', { name: /Research and compare/ })).toBeVisible()
    await expect(page.getByRole('button', { name: /Write and review a document/ })).toBeVisible()
    await expect(page.getByRole('button', { name: /Design something/ })).toBeVisible()
    const composer = page.getByRole('combobox', { name: /^Message Team room/ })
    await expect(composer).toHaveAttribute('placeholder', 'Describe the work')
    await page.getByRole('button', { name: /Build something, reviewed/ }).click()
    await expect(composer).toHaveValue('Build a small feature and have reviewer check it.')
    await expect(composer).toBeFocused()
  })
})
