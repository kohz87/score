import { expect, test, type Page } from '@playwright/test'
import { nowFixture } from './now-fixture.ts'
import { pair } from './pair.ts'

test.use({ viewport: { width: 1440, height: 1100 }, timezoneId: 'UTC', locale: 'en-GB' })

async function stubNow(page: Page) {
  const rooms = (await (await page.request.get('/api/rooms')).json()) as { rooms: { id: string }[] }
  await page.route('**/api/now', (route) =>
    route.fulfill({ json: nowFixture(rooms.rooms[0]?.id ?? 'room-fixture') }),
  )
}

test('the Score view matches the design with fixed data', async ({ page }) => {
  await pair(page)
  await stubNow(page)
  await page.goto('/now')
  const score = page.getByRole('region', { name: /^Score:/ })
  await expect(score.getByRole('button', { name: /builder: Stream, working now/ })).toBeVisible()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'Two agents are working. One thing needs you.',
  )
  await page.evaluate(() => document.fonts.ready)
  await expect(score).toHaveScreenshot('now-score.png', { maxDiffPixelRatio: 0.01 })
  await expect(page.locator('.now-cards')).toHaveScreenshot('now-cards.png', {
    maxDiffPixelRatio: 0.01,
  })
})

test('blocks are reachable by keyboard and Enter opens the task', async ({ page }) => {
  await pair(page)
  await stubNow(page)
  await page.goto('/now')
  const plan = page.getByRole('button', { name: /lead: Plan and assign, done/ })
  await plan.focus()
  await expect(plan).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/tasks\/task-plan$/)
  // Tab order walks the blocks of a lane in time order.
  await page.goto('/now')
  await page.getByRole('button', { name: /builder: Read layer/ }).focus()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('button', { name: /builder: Fix cursor/ })).toBeFocused()
})

test('approving from Now resolves the ledger', async ({ page }) => {
  await pair(page)
  await page.goto('/now')
  // Other specs own the shared approvals, so this one raises its own and puts it in the Now card.
  const api = (path: string, body?: object) =>
    page.evaluate(
      async ([url, payload]) => {
        const response = await fetch(url as string, {
          method: payload ? 'POST' : 'GET',
          headers: {
            'X-Score-Client': 'web',
            'Content-Type': 'application/json',
            'Idempotency-Key': crypto.randomUUID(),
          },
          ...(payload ? { body: JSON.stringify(payload) } : {}),
        })
        return (await response.json()) as unknown
      },
      [`/api/${path}`, body] as const,
    )
  const room = (await api('rooms', { name: `now-e2e-${Date.now()}`, leadAgentId: 'reviewer' })) as {
    id: string
  }
  await api(`rooms/${room.id}/messages`, {
    text: `Please ask for approval before installing ${Date.now()}`,
  })
  let mine: { id: string } | undefined
  await expect
    .poll(
      async () => {
        // The run's approval card lands in the room as its own message.
        const { items } = (await api(`rooms/${room.id}/messages`)) as {
          items: { parts: { kind: string; approvalId?: string }[] }[]
        }
        const approvalId = items
          .flatMap((item) => item.parts)
          .find((part) => part.kind === 'approval')?.approvalId
        mine = approvalId ? { id: approvalId } : undefined
        return mine?.id
      },
      { timeout: 20_000 },
    )
    .toBeTruthy()
  const approval = (await api(`approvals/${mine!.id}`)) as object
  await page.route('**/api/now', async (route) => {
    const response = await route.fetch()
    const body = (await response.json()) as object
    await route.fulfill({ response, json: { ...body, focusApproval: approval } })
  })
  await page.reload()
  const asking = page.getByRole('region', { name: 'Needs you' })
  await expect(asking.getByRole('button', { name: 'Approve' })).toBeVisible({ timeout: 20_000 })
  await asking.getByRole('button', { name: 'Approve' }).click()
  // The POST only queues the decision; "You approved" waits for the ledger below to confirm it.
  await expect(asking.getByRole('status').filter({ hasText: 'Decision queued' })).toBeVisible({
    timeout: 15_000,
  })
  await expect
    .poll(
      async () => {
        const { items } = (await api('approvals?status=all')) as {
          items: { id: string; decision: { by: string; choice: string } | null }[]
        }
        return items.find((item) => item.id === mine!.id)?.decision ?? null
      },
      { timeout: 15_000 },
    )
    .toMatchObject({ by: 'you', choice: 'once' })
})

test('Pause everyone and Resume everyone round trip', async ({ page }) => {
  await pair(page)
  await page.goto('/now')
  await expect(page.getByRole('heading', { level: 1 })).not.toHaveText('Now', { timeout: 15_000 })
  await page.getByRole('button', { name: 'Pause everyone' }).click()
  await expect(page.getByRole('button', { name: 'Resume everyone' })).toBeVisible()
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Everyone is paused.')
  // A fresh load keeps the state: it lives on the server. (goto, not reload: on a reload of the unbundled dev build
  // Chromium fails some of its ~130 module requests with ERR_INSUFFICIENT_RESOURCES and the page never starts.)
  await page.goto('/now')
  await expect(page.getByRole('button', { name: 'Resume everyone' })).toBeVisible()
  await page.getByRole('button', { name: 'Resume everyone' }).click()
  await expect(page.getByRole('button', { name: 'Pause everyone' })).toBeVisible()
  await expect(page.getByRole('heading', { level: 1 })).not.toContainText('Everyone is paused.')
})

test('Routines lists every agent and links to the Team page', async ({ page }) => {
  await pair(page)
  await page.goto('/now')
  await page.getByRole('link', { name: 'Routines' }).click()
  await expect(page).toHaveURL(/\/now\/routines$/)
  await expect(page.getByRole('link', { name: 'Manage on Team page' }).first()).toBeVisible()
})
