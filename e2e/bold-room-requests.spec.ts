import { expect, test } from '@playwright/test'
import { openBoldRoom, showAllJobsOnPhone } from './bold-room-fixtures.ts'
import { forEachRoomViewport, roomTestOptions } from './bold-room-spec-helpers.ts'

test.use(roomTestOptions)

function pendingApproval() {
  return {
    id: 'approval-empty-room',
    origin: 'score-run',
    phase: 'human_pending',
    status: 'pending',
    actionable: true,
    linkedTo: null,
    agentId: 'builder',
    title: 'May I install a package?',
    command: 'npm install ws@8',
    cwd: '~/app',
    description: 'The websocket feed needs ws.',
    choices: ['once', 'session', 'always', 'deny'],
    createdAt: '2026-10-24T10:07:00.000Z',
    expiresAt: null,
    decision: null,
    delivery: 'none',
    blocking: null,
    refs: [],
  }
}

forEachRoomViewport((at) => {
  test(`approvals and a paused review are protected request cards at ${at}`, async ({ page }) => {
    // The exchange answer comes back without the exchange leaving its pause, so the sent note stays readable.
    const state = await openBoldRoom(page, {
      handle: (request) =>
        request.method === 'POST' && /^\/api\/exchanges\/[^/]+\/decision$/.test(request.path)
          ? { body: { ok: true } }
          : undefined,
    })

    await showAllJobsOnPhone(page)
    const approval = page.getByRole('article', { name: /May I install a package/ })
    const review = page.getByRole('article', {
      name: /The review ended without a verdict/,
    })
    await expect(approval).toHaveAttribute('data-protected', 'flex')
    // 3.22.0: no "1 more needs you" fold; every card is in the Needs you box (it scrolls, with a "more below" cue).
    await expect(review).toHaveAttribute('data-protected', 'flex')
    await review.scrollIntoViewIfNeeded()
    await expect(review).toBeVisible()
    await expect(approval).toContainText('npm install ws@8')
    await expect(review).toContainText('Release notes 2.4')

    await approval.getByRole('button', { name: 'Allow', exact: true }).click()
    await expect(approval.getByRole('status')).toContainText('Approved by you')
    expect(
      state.requests.find(
        (request) =>
          request.method === 'POST' && request.path === '/api/approvals/approval-package/decision',
      )?.body,
    ).toEqual({ choice: 'once' })

    await review.getByRole('button', { name: 'Send back', exact: true }).click()
    await review.getByLabel('Note for the author').fill('Add the 2.3 migration steps.')
    await review.getByRole('button', { name: 'Send back', exact: true }).click()
    await expect(review.getByRole('status')).toContainText('Sent back with your note.')
    expect(
      state.requests.find(
        (request) =>
          request.method === 'POST' && request.path === '/api/exchanges/exchange-notes/decision',
      )?.body,
    ).toEqual({ option: 'send_back', note: 'Add the 2.3 migration steps.' })
  })

  test(`a fresh team room still shows an approval that names no room at ${at}`, async ({
    page,
  }) => {
    await openBoldRoom(page, {
      empty: true,
      handle: (request) =>
        request.method === 'GET' && request.path === '/api/approvals'
          ? {
              body: {
                asOfSeq: 12,
                items: [pendingApproval()],
                nextCursor: null,
              },
            }
          : undefined,
    })
    await expect(
      page.getByRole('heading', { name: 'Your team is ready. What first?' }),
    ).toBeVisible()
    // 3.24.0: no strip. With no conversation yet (board 09) there is no stream to sit in, so the card shows in place.
    const card = page.getByRole('article', { name: /May I install a package/ })
    await expect(card).toBeVisible()
    await expect(page.locator('.bold-pins')).toHaveCount(0)
    await expect(card).toHaveAttribute('data-protected', 'flex')
    await expect(card.getByRole('button', { name: 'Allow', exact: true })).toBeVisible()
  })
})
