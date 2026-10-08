import { expect, test } from '@playwright/test'

// The server prints its one-time pairing link only to the terminal, so a browser under test cannot pair.
// The decision request is therefore answered by the test; the request itself (path, body, headers) is
// asserted. The server side of approving is covered by apps/server/test/http/approvals.test.ts.
test('approves a pending approval from the task drawer', async ({ page }) => {
  let decision: { url: string; body: unknown; headers: Record<string, string> } | undefined
  await page.route('**/api/approvals/*/decision', async (route) => {
    const request = route.request()
    decision = {
      url: new URL(request.url()).pathname,
      body: request.postDataJSON(),
      headers: request.headers(),
    }
    await route.fulfill({
      status: 202,
      json: {
        id: new URL(request.url()).pathname.split('/')[3],
        origin: 'score-run',
        phase: 'decided',
        status: 'approved',
        actionable: true,
        linkedTo: null,
        agentId: 'designer',
        title: 'May I install the docs generator?',
        command: 'pnpm add -D typedoc@0.28.0',
        cwd: null,
        description: '',
        choices: ['once'],
        createdAt: '2026-10-08T12:00:00.000Z',
        expiresAt: null,
        decision: { choice: 'once', by: 'you', at: '2026-10-08T12:00:01.000Z' },
        delivery: 'intent',
        blocking: null,
        refs: [],
      },
    })
  })
  await page.goto('/tasks')
  const board = page.getByRole('region', { name: 'Tasks board' })
  const card = board.getByRole('link', { name: /T-102: Publish the pagination notes/ })
  await expect(card).toBeVisible({ timeout: 20_000 })
  await card.focus()
  await card.press('Enter')
  const drawer = page.getByRole('complementary', { name: 'Task details' })
  await expect(drawer.getByRole('heading', { name: 'Publish the pagination notes' })).toBeVisible()
  await expect(drawer.getByText('Needs you', { exact: true })).toBeVisible()
  await expect(drawer.getByRole('link', { name: '#activity-feed' })).toHaveAttribute(
    'href',
    '/chat/room-activity-feed',
  )
  await expect(drawer.getByText('Asked to install typedoc@0.28.0')).toBeVisible()
  // A task outside any run has no Flow to open.
  await expect(drawer.getByRole('link', { name: 'See it in Flow' })).toHaveCount(0)
  await drawer.getByRole('button', { name: 'Approve: install the docs generator' }).click()
  await expect.poll(() => decision?.url).toMatch(/^\/api\/approvals\/approval-docs-\d+\/decision$/)
  expect(decision?.body).toEqual({ choice: 'once' })
  expect(decision?.headers['x-score-client']).toBe('web')
  expect(decision?.headers['idempotency-key']).toBeTruthy()
  await expect(drawer.getByText('Approval sent. Waiting for the agent to continue.')).toBeVisible()
  await expect(drawer.getByRole('button', { name: /^Approve/ })).toHaveCount(0)
  const close = drawer.getByRole('link', { name: 'Close details' })
  await close.focus()
  await close.press('Escape')
  await expect(page).toHaveURL('/tasks')
  await expect(card).toBeFocused()
})
