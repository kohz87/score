import { expect, test } from '@playwright/test'
import { mockBoldRoom } from './bold-room-fixtures.ts'
import {
  at,
  openThread,
  openTopicInfo,
  orchestration,
  recipeJob,
  recipeRoom,
  sizes,
} from './bold-thread-helpers.ts'
import { pair } from './pair.ts'

test.use({ reducedMotion: 'reduce' })

for (const viewport of sizes) {
  const size = `${viewport.width}×${viewport.height}`
  test.describe(size, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize(viewport)
    })

    test(`a topic with a recipe shows its run card with the step count at ${size}`, async ({
      page,
    }) => {
      await pair(page)
      await mockBoldRoom(page)
      const recipeJobs = [
        recipeJob('job-default', 'Team room', true, null),
        recipeJob('job-plan', 'Activity feed plan', false, {
          kind: 'orchestration',
          ref: 'orch-activity',
        }),
      ]
      await page.route('**/api/**', async (route) => {
        const url = new URL(route.request().url())
        const path = url.pathname
        const json = (body: unknown) =>
          route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(body),
          })
        if (route.request().method() !== 'GET') return route.fallback()
        if (path === '/api/team-room')
          return json({ asOfSeq: 12, room: recipeRoom, jobs: recipeJobs })
        if (path === '/api/rooms/team-room/jobs') return json({ asOfSeq: 12, items: recipeJobs })
        if (path === '/api/orchestrations') return json({ asOfSeq: 12, items: [orchestration] })
        if (/^\/api\/jobs\/[^/]+\/exchanges$/.test(path)) return json({ asOfSeq: 12, items: [] })
        if (path === '/api/rooms/team-room/messages')
          return json({
            asOfSeq: 12,
            items: [],
            nextCursor: null,
            jobId: url.searchParams.get('all') === '1' ? null : 'job-plan',
          })
        return route.fallback()
      })
      await page.goto('/b?open=1')
      await expect(page.locator('[data-ui="bold"] .top .word')).toBeVisible({ timeout: 20_000 })
      const info = await openTopicInfo(page, /Activity feed plan/, true)
      await expect(info).toContainText('Activity feed plan')
      const card = page.getByRole('region', { name: 'Recipe run' })
      await expect(card).toContainText('Orchestration')
      await expect(card).toContainText('Activity feed plan')
      await expect(card).toContainText('2 of 4 steps done')
      await expect(card.getByRole('link', { name: 'Open the run' })).toHaveAttribute(
        'href',
        /^\/b\?run=brief-activity$/,
      )
    })

    test(`Info shows report-back, sends it, and lists Hermes tasks at ${size}`, async ({
      page,
    }) => {
      const state = await openThread(page, {
        reportBack: { state: 'needs_ok', tool: 'add_comment', at: null },
        tasks: [
          {
            id: 'task-thread',
            key: 'OPS-9',
            title: 'Fix the login timeout',
            column: 'working',
            hermesStatus: 'running',
            assignee: 'builder',
            reviewer: null,
            roomId: 'team-room',
            badge: null,
            progress: null,
            elapsedSec: null,
            note: null,
            updatedAt: at(6),
          },
        ],
      })
      const thread = await openTopicInfo(page, /Activity feed/)
      const report = thread
        .getByRole('status')
        .filter({ hasText: 'Send the result back to TCK-142' })
      await expect(report).toHaveAttribute('data-protected', 'block')
      await report.getByRole('button', { name: 'Send' }).click()
      await expect
        .poll(() => state.posts.some((item) => item.path === '/api/jobs/job-activity/report-back'))
        .toBe(true)

      const tasks = thread.getByRole('region', { name: 'Hermes tasks' })
      await expect(tasks).toContainText('Fix the login timeout')
      await expect(tasks).toContainText('OPS-9')
      await expect(tasks).toContainText('not tied to a job yet')
      await tasks.getByRole('button', { name: 'Show steps' }).click()
      await expect(tasks).toContainText('Reproduce the timeout')
      await expect(tasks).toContainText('Pick the new limit')
      await tasks.getByRole('button', { name: 'Comment' }).click()
      await tasks.getByLabel('Comment on Fix the login timeout').fill('Check the staging logs.')
      await tasks.getByRole('button', { name: 'Comment' }).click()
      await expect
        .poll(() => state.posts.some((item) => item.path === '/api/tasks/task-thread/actions'))
        .toBe(true)
      expect(
        state.posts.find((item) => item.path === '/api/tasks/task-thread/actions')?.body,
      ).toEqual({ action: 'comment', text: 'Check the staging logs.' })
    })
  })
}
