import { expect, test } from '@playwright/test'
import { openBoldRoom, showAllJobsOnPhone } from './bold-room-fixtures.ts'
import { at, orchestrationRun, roomJobs, sizes } from './bold-needs-you-helpers.ts'

test.use({ reducedMotion: 'reduce' })

for (const viewport of sizes) {
  const label = `${viewport.width}×${viewport.height}`

  test.describe(label, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize(viewport)
    })

    test(`a question from the lead is answered in place at ${label}`, async ({ page }) => {
      const state = await openBoldRoom(page, {
        jobs: roomJobs({ kind: 'orchestration', ref: 'orch-needs' }),
        approvals: [],
        exchanges: [],
        handle: orchestrationRun(
          [{ kind: 'inquiry', inquiryId: 'inq-1' }],
          [
            {
              id: 'inq-1',
              question: 'Should the release notes mention the migration steps?',
              status: 'open',
              answer: null,
              revision: 1,
              createdAt: at(9),
              answeredAt: null,
            },
          ],
        ),
      })
      await showAllJobsOnPhone(page)
      const card = page.getByRole('article', { name: /The lead asks/ })
      await expect(card).toHaveAttribute('data-protected', 'flex')
      await expect(card).toContainText('Should the release notes mention the migration steps?')
      await card.getByLabel(/Your answer/).fill('For the release team.')
      await card.getByRole('button', { name: 'Send answer' }).click()

      await expect(card).toHaveCount(0)
      expect(
        state.requests.find(
          (request) =>
            request.method === 'POST' &&
            request.path === '/api/orchestrations/orch-needs/inquiries/inq-1/answer',
        )?.body,
      ).toMatchObject({
        answer: 'For the release team.',
        expectedRevision: 1,
        orchestrationRevision: 9,
      })
    })

    test(`spend that is not settled is answered in place at ${label}`, async ({ page }) => {
      const state = await openBoldRoom(page, {
        jobs: roomJobs({ kind: 'orchestration', ref: 'orch-needs' }),
        approvals: [],
        exchanges: [],
        handle: orchestrationRun([{ kind: 'budget', reason: 'unknown_spend' }]),
      })
      await showAllJobsOnPhone(page)
      const card = page.getByRole('article', { name: /Spend not settled/ })
      await expect(card).toHaveAttribute('data-protected', 'flex')
      await expect(card).toContainText('Spend is unknown: decide whether to continue')
      await card.getByRole('button', { name: 'Continue although spend is unknown' }).click()

      await expect(card).toHaveCount(0)
      expect(
        state.requests.find(
          (request) =>
            request.method === 'POST' && request.path === '/api/orchestrations/orch-needs/limits',
        )?.body,
      ).toEqual({ orchestrationRevision: 9, acceptUnknownSpend: true })
    })

    test(`a low quota guard is answered in place at ${label}`, async ({ page }) => {
      const state = await openBoldRoom(page, {
        jobs: roomJobs({ kind: 'orchestration', ref: 'orch-needs' }),
        approvals: [],
        exchanges: [],
        handle: orchestrationRun([
          {
            kind: 'quota_low',
            stepId: 's3',
            agentId: 'builder',
            window: '5 hours',
            group: null,
            leftPercent: 12,
            resetsAt: at(30),
          },
        ]),
      })
      await showAllJobsOnPhone(page)
      const card = page.getByRole('article', { name: /Quota is low/ })
      await expect(card).toHaveAttribute('data-protected', 'flex')
      await expect(card).toContainText('has 12% of its 5-hour limit left')
      await card.getByRole('button', { name: 'Use it anyway' }).click()

      await expect(card).toHaveCount(0)
      expect(
        state.requests.find(
          (request) =>
            request.method === 'POST' &&
            request.path === '/api/orchestrations/orch-needs/steps/s3/quota',
        )?.body,
      ).toEqual({ answer: 'use_anyway', orchestrationRevision: 9 })
    })

    test(`work that is not confirmed as ended is answered in place at ${label}`, async ({
      page,
    }) => {
      const state = await openBoldRoom(page, {
        jobs: roomJobs({ kind: 'orchestration', ref: 'orch-needs' }),
        approvals: [],
        exchanges: [],
        handle: orchestrationRun([{ kind: 'unknown', attemptId: 'a3' }]),
      })
      await showAllJobsOnPhone(page)
      const card = page.getByRole('article', { name: /Not confirmed as ended/ })
      await expect(card).toHaveAttribute('data-protected', 'flex')
      await card.getByLabel(/This may still be running/).check()
      await card.getByRole('button', { name: 'Stop waiting for this' }).click()

      await expect(card).toHaveCount(0)
      expect(
        state.requests.find(
          (request) =>
            request.method === 'POST' && request.path === '/api/orchestrations/orch-needs/abandon',
        )?.body,
      ).toEqual({ attemptIds: ['a3'], orchestrationRevision: 9, acknowledge: true })
    })
  })
}
