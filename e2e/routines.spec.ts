import { expect, test } from '@playwright/test'

type Routine = {
  id: string
  title: string
  schedule: string
  description: string
  lastRunAt: string | null
  enabled: boolean
}

// Mutations need a paired browser, so the routines endpoints are stood in for here; the server side
// (fake and stubbed live adapters, argv, idempotency) is covered by the server tests. Creating one is the Start a job
// flow now (bold-start-job.spec.ts: "a schedule creates a routine"), so the list starts with one routine.
test('pause, run now and delete a routine from the agent page', async ({ page }) => {
  let items: Routine[] = [
    {
      id: 'builder:fake-routine-1',
      title: 'Build check',
      schedule: 'every 2h',
      description: 'Check the build and report failures.',
      lastRunAt: null,
      enabled: true,
    },
  ]
  const sent: string[] = []
  await page.route('**/api/agents/builder/routines', async (route) => {
    await route.fulfill({ json: { items } })
  })
  await page.route('**/api/routines/**', async (route) => {
    const request = route.request()
    expect(request.headers()['idempotency-key']).toBeTruthy()
    if (request.method() === 'PATCH') {
      const { enabled } = request.postDataJSON() as { enabled: boolean }
      sent.push(enabled ? 'resume' : 'pause')
      items = items.map((item) => ({ ...item, enabled }))
      await route.fulfill({ json: items[0] })
    } else if (request.method() === 'DELETE') {
      sent.push('delete')
      items = []
      await route.fulfill({ json: { id: 'builder:fake-routine-1' } })
    } else {
      sent.push('run')
      items = items.map((item) => ({ ...item, lastRunAt: '2026-10-08T09:00:00.000Z' }))
      await route.fulfill({ json: { id: 'builder:fake-routine-1', queued: true } })
    }
  })

  await page.goto('/b/team/builder#agent-routines')
  await expect(page.getByRole('heading', { name: 'builder', level: 1 })).toBeVisible()
  // The hash opens More at the repeating jobs card.
  const card = page.locator('#agent-routines')
  await expect(card.getByRole('link', { name: 'Start a repeating job' })).toBeVisible()
  const row = card.locator('.listrow').filter({ hasText: 'Build check' })
  await expect(row).toBeVisible()
  await expect(row).toContainText('every 2h')
  await row.getByRole('button', { name: 'Pause Build check' }).click()
  await expect(row).toContainText('Paused')
  await row.getByRole('button', { name: 'Resume Build check' }).click()
  await expect(row.getByRole('button', { name: 'Pause Build check' })).toBeVisible()
  await row.getByRole('button', { name: 'Run Build check now' }).click()
  await expect(card.getByRole('status').filter({ hasText: 'will run shortly' })).toBeVisible()
  // Deleting asks first (a protected decision), and cancelling changes nothing.
  await row.getByRole('button', { name: 'Delete Build check' }).click()
  const confirm = card.getByRole('group', { name: 'Remove Build check' })
  await expect(confirm).toHaveAttribute('data-protected', 'block')
  await confirm.getByRole('button', { name: 'Cancel' }).click()
  await expect(confirm).toHaveCount(0)
  expect(sent).toEqual(['pause', 'resume', 'run'])
  await row.getByRole('button', { name: 'Delete Build check' }).click()
  await card
    .getByRole('group', { name: 'Remove Build check' })
    .getByRole('button', { name: 'Remove' })
    .click()
  await expect(card.getByText('None yet.')).toBeVisible()
  expect(sent).toEqual(['pause', 'resume', 'run', 'delete'])
  // A refetch can still be inside a route handler; without this the worker errors and skips the next test.
  await page.unrouteAll({ behavior: 'ignoreErrors' })
})

test('the fake server lists routines for an agent and rejects unpaired writes', async ({
  request,
}) => {
  const list = await request.get('/api/agents/builder/routines')
  expect(list.ok()).toBe(true)
  expect(await list.json()).toEqual({ items: [] })
  const create = await request.post('/api/agents/builder/routines', {
    headers: { 'x-score-client': 'web' },
    data: { title: 'x', schedule: '1h', prompt: 'y' },
  })
  expect([401, 403]).toContain(create.status())
})
