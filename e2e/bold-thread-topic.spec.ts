import { expect, test } from '@playwright/test'
import { openBoldJob } from './bold-room-fixtures.ts'
import { budgetPause, openThread, openTopicInfo, sizes } from './bold-thread-helpers.ts'

test.use({ reducedMotion: 'reduce' })

for (const viewport of sizes) {
  const size = `${viewport.width}×${viewport.height}`
  test.describe(size, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize(viewport)
    })

    test(`a live topic shows its status, turns and Stop in Info at ${size}`, async ({ page }) => {
      const state = await openThread(page)
      const topic = await openTopicInfo(page, /Activity feed/)

      await expect(topic.getByText('Activity feed', { exact: true }).first()).toBeVisible()
      await expect(topic.locator('.bold-topic-status')).toContainText('5 of 8 turns used')
      // No exchange waits on the person, so no needs-you pill shows.
      await expect(topic.locator('.bold-topic-status [data-protected]')).toHaveCount(0)
      // The topic's messages are in the one conversation (the rounds headings of the old panel are gone).
      await expect(page.getByText('The cursor jumps on refresh.')).toBeVisible()
      await expect(page.getByText('Cursor is stable now.')).toBeVisible()

      // Stop asks first, and the confirmation is a protected surface.
      await topic.getByRole('button', { name: 'Stop job', exact: true }).click()
      const confirm = page.getByRole('alertdialog', { name: 'Stop Activity feed?' })
      await expect(confirm).toHaveAttribute('data-protected', 'block')
      await confirm.getByRole('button', { name: 'Keep going' }).click()
      await expect(confirm).toHaveCount(0)
      expect(state.posts.some((item) => item.path === '/api/jobs/job-activity/end')).toBe(false)
      await topic.getByRole('button', { name: 'Stop job', exact: true }).click()
      await page.getByRole('alertdialog').getByRole('button', { name: 'Stop job' }).click()
      await expect(page.getByRole('status').filter({ hasText: 'Stopped.' })).toBeVisible()
      expect(state.posts.filter((item) => item.path === '/api/jobs/job-activity/end')).toHaveLength(
        1,
      )

      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        viewport.width,
      )
    })

    test(`a topic's messages have the action row and delete works at ${size}`, async ({ page }) => {
      const deletes: string[] = []
      await openThread(page, {
        handle: (path, method) => {
          if (method === 'DELETE' && path.startsWith('/api/rooms/team-room/messages/')) {
            deletes.push(path)
            return { body: null, status: 204 }
          }
          return undefined
        },
      })
      await openBoldJob(page, /Activity feed/)
      const own = page.locator('[data-message-id="t-1"]')
      await own.hover()
      await expect(own.getByRole('button', { name: 'Edit message from You' })).toBeVisible()
      await expect(own.getByRole('button', { name: 'Copy message from You' })).toBeVisible()
      await expect(own.getByRole('button', { name: 'Pin message from You' })).toBeVisible()
      const reply = page.locator('[data-message-id="t-2"]')
      await reply.hover()
      await expect(
        reply.getByRole('button', { name: 'Try another reply from builder' }),
      ).toBeVisible()
      // A later agent message in the same run of replies answers the person too.
      const later = page.locator('[data-message-id="t-4"]')
      await later.hover()
      await expect(later.getByRole('button', { name: /^Try another reply/ })).toHaveCount(1)

      // An agent's message goes at once (undo window), then the DELETE is sent.
      await reply.hover()
      await reply.getByRole('button', { name: 'Delete message from builder' }).click()
      await expect(page.getByText('First cut is ready for review.')).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'Undo' })).toBeVisible()
      await expect
        .poll(() => deletes, { timeout: 15_000 })
        .toEqual(['/api/rooms/team-room/messages/t-2'])
      await own.hover()
      await own.getByRole('button', { name: 'Edit message from You' }).click()
      await expect(page.locator('.bold-room-composer textarea')).toBeFocused()
      await expect(page.getByText('Editing your message')).toBeVisible()
    })

    test(`a job-limit pause says so in Info at ${size}`, async ({ page }) => {
      await openThread(page, { exchange: budgetPause(3, 'job_limit') })
      const topic = await openTopicInfo(page, /Release notes 2\.4/)
      await expect(topic.locator('.bold-topic-status')).toContainText('Job turn limit reached (40)')
      await expect(topic.locator('.bold-topic-status')).not.toContainText('3 of 8')
    })
  })
}
