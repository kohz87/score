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
// (fake and stubbed live adapters, argv, idempotency) is covered by the server tests.
test('create, pause, run now and delete a routine from the Team page', async ({ page }) => {
  let items: Routine[] = []
  const sent: string[] = []
  await page.route('**/api/agents/builder/routines', async (route) => {
    const request = route.request()
    if (request.method() === 'POST') {
      const body = request.postDataJSON() as { title: string; schedule: string; prompt: string }
      expect(request.headers()['idempotency-key']).toBeTruthy()
      sent.push(`create ${body.title}`)
      const created: Routine = {
        id: 'builder:fake-routine-1',
        title: body.title,
        schedule: body.schedule,
        description: body.prompt,
        lastRunAt: null,
        enabled: true,
      }
      items = [...items, created]
      await route.fulfill({ json: created })
    } else await route.fulfill({ json: { items } })
  })
  await page.route('**/api/routines/**', async (route) => {
    const request = route.request()
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

  await page.goto('/team/builder')
  await expect(page.getByRole('heading', { name: 'builder', level: 1 })).toBeVisible()
  // The Overview link opens the create form on the Routines tab.
  await page.getByRole('button', { name: 'New routine' }).click()
  await expect(page.getByRole('tab', { name: 'Routines' })).toHaveAttribute('aria-selected', 'true')
  const form = page.getByRole('form', { name: 'New routine' })
  await form.getByLabel('Title').fill('Build check')
  await form.getByLabel('Schedule').fill('every 2h')
  await form.getByLabel('Prompt').fill('Check the build and report failures.')
  await form.getByRole('button', { name: 'Create routine' }).click()

  const row = page.getByRole('listitem').filter({ hasText: 'Build check' })
  await expect(row).toBeVisible()
  await expect(row).toContainText('every 2h')
  await row.getByRole('button', { name: 'Pause Build check' }).click()
  await expect(row).toContainText('Paused')
  await row.getByRole('button', { name: 'Resume Build check' }).click()
  await expect(row.getByRole('button', { name: 'Pause Build check' })).toBeVisible()
  await row.getByRole('button', { name: 'Run Build check now' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'will run shortly' })).toBeVisible()
  await row.getByRole('button', { name: 'Delete Build check' }).click()
  await row.getByRole('button', { name: 'Confirm deleting Build check' }).click()
  await expect(page.getByText('No routines configured.')).toBeVisible()
  expect(sent).toEqual(['create Build check', 'pause', 'resume', 'run', 'delete'])
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
