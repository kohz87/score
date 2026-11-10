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
test('pause, run now and delete a routine from Tasks › Repeating', async ({ page }) => {
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
  // Decision 183: the agent page shows what's assigned; Tasks › Repeating lists every agent's jobs.
  const asJobs = () =>
    items.map((item) => ({
      ...item,
      agentId: 'builder',
      nextRunAt: null,
      provider: null,
      deliverTo: null,
    }))
  const sent: string[] = []
  await page.route('**/api/agents/builder/routines', async (route) => {
    await route.fulfill({ json: { items } })
  })
  await page.route('**/api/agents/builder/assigned', async (route) => {
    await route.fulfill({ json: { agentId: 'builder', repeating: asJobs(), recipeSteps: [] } })
  })
  await page.route('**/api/routines', async (route) => {
    await route.fulfill({ json: { items: asJobs(), unreadable: [] } })
  })
  await page.route('**/api/routines/**', async (route) => {
    const request = route.request()
    expect(request.headers()['idempotency-key']).toBeTruthy()
    if (request.method() === 'PATCH') {
      const { enabled } = request.postDataJSON() as { enabled: boolean }
      sent.push(enabled ? 'resume' : 'pause')
      items = items.map((item) => ({ ...item, enabled }))
      await route.fulfill({ json: asJobs()[0] })
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

  await page.goto('/b/agents/builder#agent-routines')
  await expect(page.getByRole('heading', { name: 'builder', level: 1 })).toBeVisible()
  // The agent page's Work shows the job as Assigned (read-only); Open in Tasks goes to Repeating, where it is managed.
  const assigned = page.locator('.bold-assigned-tile')
  await expect(assigned).toContainText('Build check')
  await expect(assigned.getByRole('link', { name: 'Start a repeating job' })).toBeVisible()
  await assigned.getByRole('link', { name: 'Open in Tasks' }).click()
  await expect(page).toHaveURL(/\/b\/tasks\/repeating\?agent=builder/)
  const row = page.getByRole('row', { name: /Build check/ })
  await expect(row).toContainText('Every 2 hours')
  // Pause and Resume are in the job's panel.
  const edit = () => row.getByRole('button', { name: 'Edit Build check' }).click()
  const panel = page.getByRole('complementary', { name: 'Edit Build check' })
  await edit()
  await panel.getByRole('button', { name: 'Pause' }).click()
  await expect(row).toContainText('Paused')
  await edit()
  await panel.getByRole('button', { name: 'Resume' }).click()
  await expect(row).toContainText('On')
  await row.getByRole('button', { name: 'Run Build check now' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Started Build check.' })).toBeVisible()
  // Deleting asks first (a protected decision), and keeping it changes nothing.
  await edit()
  await panel.getByRole('button', { name: 'Delete…' }).click()
  const confirm = panel.getByRole('alert').filter({ hasText: 'Delete “Build check”?' })
  await expect(confirm).toHaveAttribute('data-protected', 'block')
  await confirm.getByRole('button', { name: 'Keep it' }).click()
  await expect(confirm).toHaveCount(0)
  expect(sent).toEqual(['pause', 'resume', 'run'])
  await panel.getByRole('button', { name: 'Delete…' }).click()
  await panel.getByRole('alert').getByRole('button', { name: 'Delete it' }).click()
  await expect(page.getByText(/No repeating jobs yet/)).toBeVisible()
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
