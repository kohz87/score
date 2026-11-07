import { expect, test } from '@playwright/test'
import { openInfoSection } from './bold-chat-helpers.ts'
import {
  openBoldJob,
  openBoldRoom,
  openTopicsOnPhone,
  showAllJobsOnPhone,
} from './bold-room-fixtures.ts'
import {
  expectDestination,
  forEachRoomViewport,
  roomTestOptions,
} from './bold-room-spec-helpers.ts'

test.use(roomTestOptions)

forEachRoomViewport((at, viewport) => {
  test(`topics: the phone list keeps unread counts, and Info › Topics picks the current topic at ${at}`, async ({
    page,
  }) => {
    // 3.22.0: job tabs and the D10 filter chips are gone (one merged conversation with dividers). The topic list
    // (phone: All topics; desktop: Info › Topics) picks the current topic, and the context bar says where a message goes.
    await openBoldRoom(page)

    if (viewport.width <= 860) {
      // 3.24.0: the All topics screen is gone; Info › Topics (the sheet, or an old `?jobs=1` link) lists the topics.
      await openTopicsOnPhone(page)
      // 3.28.0: the seeded team room is a legacy room: its two active jobs list under Open jobs, the done one under Past jobs.
      await expect(page.getByRole('heading', { name: 'Past jobs' })).toBeVisible()
      await openInfoSection(page, 'Open jobs')
      await openInfoSection(page, 'Past jobs')
      const row = (title: string) =>
        page
          .locator('.bold-chat-topics a')
          .filter({ has: page.locator('.bold-chat-topic-title', { hasText: title }) })
      const activity = row('Activity feed')
      const notes = row('Release notes 2.4')
      const queue = row('Queue research')
      await expect(activity).toBeVisible()
      await expect(notes).toBeVisible()
      await expect(queue).toBeVisible()
      await expect(activity.locator('.bold-unread')).toHaveText('2')
      await expect(notes.locator('.bold-unread')).toHaveText('3')
      await expect(queue.locator('.bold-unread')).toHaveCount(0)

      await activity.click()
      expect(new URL(page.url()).searchParams.get('job')).toBe('job-activity')
      await expectDestination(page, 'Activity feed')
      await expect(
        page.getByText('Read layer is ready. The feed renders newest first.'),
      ).toBeVisible()
      // The pick closes the sheet and the browser's Back leaves the topic again.
      await expect(page.getByRole('button', { name: 'Back to chats' })).toBeVisible()
      await page.goBack()
      expect(new URL(page.url()).searchParams.get('job')).toBeNull()
      return
    }

    const side = page.getByRole('complementary', { name: 'Side panel' })
    await openInfoSection(side, 'Open jobs')
    await openInfoSection(side, 'Past jobs')
    const activity = side.getByRole('link', { name: /Activity feed/ })
    await expect(side.getByRole('link', { name: /Release notes 2\.4/ })).toBeVisible()
    await expect(side.getByRole('link', { name: /Queue research/ })).toBeVisible()
    await activity.click()
    expect(new URL(page.url()).searchParams.get('job')).toBe('job-activity')
    await expectDestination(page, 'Activity feed')
    await expect(
      page.getByText('Read layer is ready. The feed renders newest first.'),
    ).toBeVisible()
    // The tabs and filter chips are gone from above the conversation.
    await expect(page.getByRole('tab', { name: /Activity feed/ })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Needs you', exact: true })).toHaveCount(0)
  })

  test(`result links open the job and seek to its message at ${at}`, async ({ page }) => {
    await openBoldRoom(page)
    await showAllJobsOnPhone(page)
    const href = '/b?job=job-queue&message=message-queue'
    // 3.22.0: the "Open result" card of a finished job (the job folds) is gone with the tabs; a result link is a plain
    // address (Search and notifications open it the same way), followed here.
    if (viewport.width <= 860) {
      await openBoldJob(page, /^Queue research$/)
      await expect(page).toHaveURL(/[?&]job=job-queue/)
      await expect(page.getByRole('button', { name: 'Back to chats' })).toBeVisible()
    }
    await page.goto(href)
    await expect(page).toHaveURL(/[?&]job=job-queue/)
    if (viewport.width <= 860)
      await expect(page.getByRole('button', { name: 'Back to chats' })).toBeVisible()
    await expectDestination(page, 'Queue research')
    const article = page.locator('#message-message-queue')
    await expect(article).toHaveClass(/bold-message-hit/)
    await expect(article).toBeFocused()
  })
})
