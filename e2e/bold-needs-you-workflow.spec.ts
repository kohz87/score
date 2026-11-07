import { expect, test } from '@playwright/test'
import { openBoldRoom, showAllJobsOnPhone } from './bold-room-fixtures.ts'
import { roomJobs, sizes, workflowRun } from './bold-needs-you-helpers.ts'

test.use({ reducedMotion: 'reduce' })

for (const viewport of sizes) {
  const label = `${viewport.width}×${viewport.height}`

  test.describe(label, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize(viewport)
    })

    test(`retry, try again and remap are answered in place at ${label}`, async ({ page }) => {
      const state = await openBoldRoom(page, {
        jobs: roomJobs({ kind: 'workflow', ref: 'wfrun-needs' }),
        approvals: [],
        exchanges: [],
        handle: workflowRun([
          { kind: 'retry', nodeId: 'review', attemptsLeft: 1 },
          { kind: 'refusal_limit', nodeId: 'review', attemptId: 'h-review', refusals: 3 },
          {
            kind: 'remap',
            agentId: 'reviewer',
            frozenIncarnation: 'inc-reviewer-old',
            currentIncarnation: 'inc-reviewer-new',
            nodeIds: ['review'],
            plan: [
              {
                nodeId: 'review',
                retiresAttemptId: null,
                payloadHash: 'review-payload',
                payload: 'Review the draft.',
              },
            ],
          },
        ]),
      })
      await showAllJobsOnPhone(page)
      // 3.22.0: no fold; every card is already in view.

      const retry = page
        .getByRole('article', { name: /A step needs another try/ })
        .filter({ hasText: 'You stopped waiting for Review the draft' })
      await retry.getByLabel(/earlier try may still be running/).check()
      await retry.getByRole('button', { name: 'Retry Review the draft' }).click()
      await expect(retry).toHaveCount(0)

      const refusal = page
        .getByRole('article', { name: /A step needs another try/ })
        .filter({ hasText: 'Hermes has refused this step 3 times' })
      await refusal.getByRole('button', { name: 'Try again' }).click()
      await expect(refusal).toHaveCount(0)

      const remap = page.getByRole('article', { name: /An agent was replaced/ })
      await remap.getByRole('button', { name: 'Use the new reviewer for this run' }).click()
      await expect(remap).toHaveCount(0)

      const paths = state.requests
        .filter((request) => request.method === 'POST')
        .map((request) => request.path)
      expect(paths).toEqual(
        expect.arrayContaining([
          '/api/workflow-runs/wfrun-needs/nodes/review/retry',
          '/api/workflow-runs/wfrun-needs/nodes/review/try-again',
          '/api/workflow-runs/wfrun-needs/remap',
        ]),
      )
    })
  })
}
