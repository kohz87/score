import { expect, test } from '@playwright/test'
import { openBoldJob } from './bold-room-fixtures.ts'
import { openMenuRoom } from './bold-room-menu-fixtures.ts'
import {
  forEachMenuViewport,
  jobMenu,
  menuTestOptions,
  onScreen,
  openPhoneJobList,
  share,
  topicHead,
  topicRow,
} from './bold-room-menu-spec-helpers.ts'

test.use(menuTestOptions)

forEachMenuViewport((at, viewport) => {
  test(`the job menu shares that job and exports the classic room at ${at}`, async ({ page }) => {
    const state = await openMenuRoom(page)
    await openBoldJob(page, /Activity feed/)
    await jobMenu(page, 'Activity feed').click()
    const menu = page.getByRole('menu', { name: 'Activity feed actions' })
    await expect(menu).toHaveAttribute('data-protected', 'flex')
    await expect(menu).toContainText('Rename…')
    await expect(menu).toContainText('Close')
    await expect(menu).toContainText('Share a read-only link')
    await expect(menu).toContainText('Export the whole room as Markdown')
    await expect(menu).toContainText('Delete job')
    await onScreen(page, menu)

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

    await jobMenu(page, 'Activity feed').click()
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
    // 3.28.0: the seeded room is a legacy one (two active jobs), so it keeps its dividers and their job menus until
    // only one job is active.
    await openBoldJob(page, /Activity feed/)
    await jobMenu(page, 'Activity feed').click()
    await page.getByRole('menuitem', { name: 'Rename…' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toHaveAttribute('data-protected', 'any')
    await dialog.getByLabel('Name').fill('Activity feed v2')
    await dialog.getByRole('button', { name: 'Rename' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Renamed' })).toBeVisible()
    await expect(topicHead(page, 'Activity feed v2')).toBeVisible()
    expect(
      state.requests.find(
        (request) => request.method === 'PATCH' && request.path === '/api/jobs/job-activity',
      )?.body,
    ).toEqual({ title: 'Activity feed v2' })

    await jobMenu(page, 'Activity feed v2').click()
    await page.getByRole('menuitem', { name: 'Close' }).click()
    await expect(
      page.getByRole('status').filter({ hasText: 'Closed “Activity feed v2”' }),
    ).toBeVisible()
    // One active job is left, so the dividers go and the job bar shows it; the closed job is listed under Past jobs, and
    // opening it shows its read-only bar with the menu.
    await expect(page.locator('.bold-job-bar:not(.is-past)')).toContainText('Release notes 2.4')
    await expect(topicHead(page, 'Activity feed v2')).toHaveCount(0)
    if (viewport.width > 860) await openBoldJob(page, /Activity feed v2/)
    else {
      await openPhoneJobList(page)
      await expect(topicRow(page, 'Activity feed v2')).toBeVisible()
      await topicRow(page, 'Activity feed v2').click()
    }
    await expect(page.locator('.bold-job-bar.is-past')).toContainText('Activity feed v2')
    // The past job's bar carries its menu on a desktop; a phone's chat head is expected to (see the report: it does not).
    await page
      .locator('.bold-job-bar.is-past, .bold-chat-phone-bar')
      .getByRole('button', { name: 'Job menu' })
      .click()
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
    await jobMenu(page, 'Activity feed').click()
    await page.getByRole('menuitem', { name: 'Delete job' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toHaveAttribute('data-protected', 'any')
    await dialog.getByLabel(/Type Activity feed to confirm/).fill('Activity feed')
    await dialog.getByRole('button', { name: 'Delete job' }).click()
    const undo = page.getByRole('status').filter({ hasText: 'Job deleted' })
    await expect(undo).toBeVisible()
    if (viewport.width > 860) await expect(topicHead(page, 'Activity feed')).toHaveCount(0)
    else {
      await openPhoneJobList(page)
      await expect(topicRow(page, 'Activity feed')).toHaveCount(0)
      await page.keyboard.press('Escape')
    }
    await undo.getByRole('button', { name: 'Undo' }).click()
    await expect(
      page.getByRole('status').filter({ hasText: 'Restored “Activity feed”' }),
    ).toBeVisible()
    if (viewport.width > 860) await expect(topicHead(page, 'Activity feed')).toBeVisible()
    else {
      await openPhoneJobList(page)
      await expect(topicRow(page, 'Activity feed')).toBeVisible()
      await page.keyboard.press('Escape')
    }
    expect(
      state.requests.some(
        (request) => request.method === 'POST' && request.path === '/api/jobs/job-activity/restore',
      ),
    ).toBe(true)
  })

  test(`a closed job survives a reload under Closed jobs at ${at}`, async ({ page }) => {
    await openMenuRoom(page)
    await page.reload()
    await expect(page.locator('[data-ui="bold"] .top .word')).toBeVisible({ timeout: 20_000 })
    if (viewport.width > 860) {
      // 3.22.0: a closed topic is a divider in the conversation, marked closed.
      await expect(topicHead(page, 'Old import')).toContainText('closed')
    } else {
      await openPhoneJobList(page)
      await expect(topicRow(page, 'Old import')).toBeVisible()
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
    await jobMenu(page, 'Activity feed').click()
    await page.getByRole('menuitem', { name: 'Delete job' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel(/Type Activity feed to confirm/).fill('Activity feed')
    await dialog.getByRole('button', { name: 'Delete job' }).click()
    await page.getByRole('button', { name: 'Agents', exact: true }).click()
    const undo = page.getByRole('status').filter({ hasText: 'Job deleted' })
    await expect(undo).toBeVisible()
    await undo.getByRole('button', { name: 'Undo' }).click()
    await expect(
      page.getByRole('status').filter({ hasText: 'Restored “Activity feed”' }),
    ).toBeVisible()
    expect(
      state.requests.some(
        (request) => request.method === 'POST' && request.path === '/api/jobs/job-activity/restore',
      ),
    ).toBe(true)
  })

  test(`the job menu works from the keyboard at ${at}`, async ({ page }) => {
    await openMenuRoom(page)
    await openBoldJob(page, /Activity feed/)
    const trigger = jobMenu(page, 'Activity feed')
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
})
