import { expect, test } from '@playwright/test'
import { openBoldJob, openBoldRoom } from './bold-room-fixtures.ts'
import { approval, at, roomJobs, sizes, type Json } from './bold-needs-you-helpers.ts'

test.use({ reducedMotion: 'reduce' })

for (const viewport of sizes) {
  const label = `${viewport.width}×${viewport.height}`

  test.describe(label, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize(viewport)
    })

    test(`an approval opens More and is answered in place at ${label}`, async ({ page }) => {
      const state = await openBoldRoom(page, {
        jobs: roomJobs(),
        exchanges: [],
      })
      const card = page.getByRole('article', { name: /May I install a package/ })
      await expect(card).toHaveAttribute('data-protected', 'flex')
      await expect(card).toContainText('npm install ws@8')
      // Read the job that owns the approval message; only then can the strip know its real job.
      await openBoldJob(page, /Activity feed/)
      await expect(card).toContainText('Activity feed')

      await card.getByRole('button', { name: 'More', exact: true }).click()
      await expect(card.getByRole('group', { name: 'More approval choices' })).toBeVisible()
      await expect(card.getByRole('button', { name: 'More', exact: true })).toHaveAttribute(
        'aria-expanded',
        'true',
      )
      await card.getByRole('button', { name: 'Approve for this session' }).click()

      // The card stays with the answer until the stream says it is resolved (no stream on this mock).
      await expect(card.getByRole('status')).toContainText('Approved')
      expect(
        state.requests.find(
          (request) =>
            request.method === 'POST' &&
            request.path === '/api/approvals/approval-package/decision',
        )?.body,
      ).toEqual({ choice: 'session' })
    })

    test(`the stream shows a pointer, not a second Allow, at ${label}`, async ({ page }) => {
      await openBoldRoom(page, { jobs: roomJobs(), exchanges: [] })
      const card = page.getByRole('article', { name: /May I install a package/ })
      await expect(card.getByRole('button', { name: 'Allow', exact: true })).toBeVisible()
      // On a phone the stream is the chat of the open job; the pointer lives in the job that holds the approval message.
      if (page.viewportSize()!.width <= 860) await openBoldJob(page, /^Activity feed$/)
      await expect(page.getByRole('button', { name: 'Allow', exact: true })).toHaveCount(1)
      await expect(page.getByText('Waiting in Needs you')).toBeVisible()
    })

    test(`an approval from another room never lands in this strip at ${label}`, async ({
      page,
    }) => {
      const foreign = {
        ...approval('approval-foreign', 'May I install a package?'),
        refs: [{ kind: 'room', roomId: 'other-room' }],
      }
      await openBoldRoom(page, { jobs: roomJobs(), approvals: [foreign], exchanges: [] })
      await expect(page.getByRole('article', { name: /May I install a package/ })).toHaveCount(0)
      await expect(page.getByText('May I install a package')).toHaveCount(0)
    })

    test(`an approval leaves when the server resolves it at ${label}`, async ({ page }) => {
      const served: Json = approval('approval-package', 'May I install a package?')
      const decided = {
        ...served,
        phase: 'decided',
        status: 'approved',
        actionable: false,
        decision: { choice: 'once', by: 'you', at: at(12) },
        delivery: 'applied',
      }
      const state = await openBoldRoom(page, {
        jobs: roomJobs(),
        exchanges: [],
        handle: (request) => {
          if (request.method === 'GET' && request.path === '/api/approvals')
            return { body: { asOfSeq: 12, items: [served], nextCursor: null } }
          if (request.method === 'GET' && request.path === '/api/approvals/approval-package')
            return { body: served }
          return undefined
        },
      })
      const card = page.getByRole('article', { name: /May I install a package/ })
      await expect(card).toBeVisible()
      if (page.viewportSize()!.width <= 860) await openBoldJob(page, /^Activity feed$/)
      await expect(page.getByText('Waiting in Needs you')).toBeVisible()

      // The decision is now the server's state; reloading is a fresh read of that state.
      Object.assign(served, decided)
      await page.reload()
      await expect(card).toHaveCount(0)
      await expect(page.getByText('Waiting in Needs you')).toHaveCount(0)
      const stream = page.locator('.stream')
      await expect(stream.getByText('Approved by you')).toBeVisible()
      expect(state.requests.some((request) => request.path === '/api/approvals')).toBe(true)
    })

    for (const failure of [
      { status: 409, code: 'conflict', message: 'Someone already answered this.', shown: null },
      { status: 403, code: 'forbidden', message: 'Pair first.', shown: 'Pair this browser first.' },
    ]) {
      test(`a ${failure.status} on Allow keeps the card and says why at ${label}`, async ({
        page,
      }) => {
        await openBoldRoom(page, {
          jobs: roomJobs(),
          exchanges: [],
          handle: (request) =>
            request.method === 'POST' && request.path === '/api/approvals/approval-package/decision'
              ? {
                  status: failure.status,
                  body: { error: { code: failure.code, message: failure.message } },
                }
              : undefined,
        })
        const card = page.getByRole('article', { name: /May I install a package/ })
        await card.getByRole('button', { name: 'Allow', exact: true }).click()
        await expect(card.getByRole('alert')).toHaveText(failure.shown ?? failure.message)
        await expect(card.getByRole('button', { name: 'Allow', exact: true })).toBeEnabled()
      })
    }

    test(`a failed delivery shows Retry in the strip at ${label}`, async ({ page }) => {
      const failed = {
        ...approval('approval-package', 'May I install a package?'),
        delivery: 'failed',
      }
      const state = await openBoldRoom(page, {
        jobs: roomJobs(),
        approvals: [failed],
        exchanges: [],
      })
      const card = page.getByRole('article', { name: /May I install a package/ })
      await expect(card).toContainText('Couldn’t deliver your answer. Try again.')
      await card.getByRole('button', { name: 'Retry', exact: true }).click()
      await expect
        .poll(() =>
          state.requests.some(
            (request) =>
              request.method === 'POST' &&
              request.path === '/api/approvals/approval-package/decision',
          ),
        )
        .toBe(true)
    })

    test(`an approval that only Hermes can answer says so at ${label}`, async ({ page }) => {
      await openBoldRoom(page, {
        jobs: roomJobs(),
        approvals: [
          { ...approval('approval-package', 'May I install a package?'), actionable: false },
        ],
        exchanges: [],
      })
      const card = page.getByRole('article', { name: /May I install a package/ })
      await expect(card).toContainText('This approval can only be answered in Hermes.')
      await expect(card.getByRole('button', { name: 'Allow', exact: true })).toHaveCount(0)
    })
  })
}
