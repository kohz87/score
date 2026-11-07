import { expect, test } from '@playwright/test'
import { openBoldRoom } from './bold-room-fixtures.ts'
import { at, job, roomJobs, sizes } from './bold-needs-you-helpers.ts'

test.use({ reducedMotion: 'reduce' })

for (const viewport of sizes) {
  const label = `${viewport.width}×${viewport.height}`

  test.describe(label, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize(viewport)
    })

    test(`a blocked Hermes task is a protected card, and unblock leaves it at ${label}`, async ({
      page,
    }) => {
      let task = {
        id: 'task-blocked',
        key: 'OPS-7',
        title: 'Fix the login timeout',
        column: 'needs_you',
        hermesStatus: 'blocked',
        assignee: 'builder',
        reviewer: null,
        roomId: 'team-room',
        badge: { kind: 'blocked', label: 'Waiting for a decision on the timeout' } as {
          kind: string
          label: string
        } | null,
        progress: null,
        elapsedSec: null,
        note: null,
        updatedAt: at(6),
      }
      const state = await openBoldRoom(page, {
        jobs: roomJobs(),
        approvals: [],
        exchanges: [],
        handle: (request) => {
          if (request.method === 'GET' && request.path === '/api/tasks')
            return {
              body: {
                asOfSeq: 12,
                columns: {
                  planned: [],
                  working: [],
                  in_review: [],
                  needs_you: [task],
                  done: [],
                },
              },
            }
          if (request.method === 'GET' && request.path === '/api/tasks/task-blocked')
            return {
              body: {
                ...task,
                body: 'The timeout needs a decision.',
                createdBy: 'you',
                steps: [],
                activity: [],
                pendingApproval: null,
                dependsOn: [],
                blocks: [],
                runIds: [],
              },
            }
          if (request.method === 'POST' && request.path === '/api/tasks/task-blocked/actions') {
            // Hermes has not moved the task yet: only the server state may remove the card.
            return { body: { taskId: task.id, action: 'unblock', ok: true } }
          }
          return undefined
        },
      })
      const card = page.getByRole('article', { name: /Blocked task: Fix the login timeout/ })
      await expect(card).toHaveAttribute('data-protected', 'flex')
      await expect(card).toContainText('OPS-7')
      await expect(card).toContainText('Waiting for a decision on the timeout')
      await card.getByRole('button', { name: 'Unblock' }).click()
      await card.getByLabel('Note (optional)').fill('Use a 30 second timeout.')
      await card.getByRole('button', { name: 'Unblock' }).click()
      await expect
        .poll(() =>
          state.requests.some(
            (request) =>
              request.method === 'POST' && request.path === '/api/tasks/task-blocked/actions',
          ),
        )
        .toBe(true)
      expect(
        state.requests.find(
          (request) =>
            request.method === 'POST' && request.path === '/api/tasks/task-blocked/actions',
        )?.body,
      ).toEqual({ action: 'unblock', text: 'Use a 30 second timeout.' })
      await expect(card.getByText('Sent — waiting for Hermes')).toBeVisible()
      await expect(card.getByRole('button', { name: 'Sent' })).toBeDisabled()
      // Hermes moves the task on; a task no longer blocked is not a needs-you card.
      task = { ...task, column: 'working', hermesStatus: 'running', badge: null }
      await page.reload()
      await expect(
        page.getByRole('article', { name: /Blocked task: Fix the login timeout/ }),
      ).toHaveCount(0)
    })

    test(`report-back needs your OK as a counted, protected card at ${label}`, async ({ page }) => {
      const state = await openBoldRoom(page, {
        jobs: [
          job('job-default', 'Team room', { isDefault: true, holderAgentId: 'lead' }),
          job('job-activity', 'Activity feed', {
            source: {
              app: 'Tickets app',
              ref: 'TCK-142',
              title: 'Login times out',
              link: null,
              triggerId: 'trigger-1',
              missing: [],
            },
            reportBack: { state: 'needs_ok', tool: 'add_comment', at: null },
          }),
        ],
        approvals: [],
        exchanges: [],
        handle: (request) => {
          if (request.method === 'POST' && request.path === '/api/jobs/job-activity/report-back')
            return { body: { ok: true } }
          return undefined
        },
      })
      const card = page.getByRole('article', { name: /Report back: Activity feed/ })
      await expect(card).toHaveAttribute('data-protected', 'flex')
      await expect(card).toContainText('Send the result back to TCK-142?')
      await card.getByRole('button', { name: 'Send' }).dblclick()
      await expect
        .poll(
          () =>
            state.requests.filter(
              (request) =>
                request.method === 'POST' && request.path === '/api/jobs/job-activity/report-back',
            ).length,
        )
        .toBe(1)
    })

    test(`a blocked task with no room belongs to the team room only at ${label}`, async ({
      page,
    }) => {
      await openBoldRoom(page, {
        jobs: roomJobs(),
        approvals: [],
        exchanges: [],
        handle: (request) =>
          request.method === 'GET' && request.path === '/api/tasks'
            ? {
                body: {
                  asOfSeq: 12,
                  columns: {
                    planned: [],
                    working: [],
                    in_review: [],
                    needs_you: [
                      {
                        id: 'task-unassigned',
                        key: 'OPS-8',
                        title: 'Pick the timeout',
                        column: 'needs_you',
                        hermesStatus: 'blocked',
                        assignee: null,
                        reviewer: null,
                        roomId: null,
                        badge: { kind: 'blocked', label: 'No room yet' },
                        progress: null,
                        elapsedSec: null,
                        note: null,
                        updatedAt: at(6),
                      },
                    ],
                    done: [],
                  },
                },
              }
            : undefined,
      })
      await expect(
        page.getByRole('article', { name: /Blocked task: Pick the timeout/ }),
      ).toBeVisible()
    })
  })
}
