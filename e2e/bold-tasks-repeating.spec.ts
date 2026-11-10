import { expect, test, type Page } from '@playwright/test'
import { acquireLock } from './locks.ts'
import { pair } from './pair.ts'

// Decision 183, TR.2: Tasks › Repeating. The routines and recipe-schedule endpoints are stood in for with contract-shaped
// fixtures (writes need a paired browser and the server side is covered by its own tests); the shell, pairing, the
// agents and the chats are the fake adapter's. Nothing real is changed, so the 'roster' lock is only held because the
// agents list is read. Written by reading, not run here: the release's full check runs it.
test.use({ reducedMotion: 'reduce' })

let release: (() => void) | undefined
test.beforeEach(async ({ page }) => {
  release = await acquireLock('roster')
  await pair(page)
})
test.afterEach(() => {
  release?.()
  release = undefined
})

type Job = Record<string, unknown> & { id: string; agentId: string }
const job = (id: string, agentId: string, extra: Record<string, unknown> = {}): Job => ({
  id,
  agentId,
  title: `Job ${id}`,
  schedule: '0 8 * * *',
  description: `Do ${id}`,
  lastRunAt: null,
  enabled: true,
  model: null,
  provider: null,
  nextRunAt: null,
  deliverTo: null,
  ...extra,
})

async function mockRepeating(page: Page) {
  const state = {
    jobs: [
      job('builder:r1', 'builder', {
        title: 'Morning summary',
        description: 'Summarise yesterday',
      }),
      job('lead:r2', 'lead', { title: 'Weekly report', schedule: '0 17 * * 5', model: 'deep' }),
    ],
    writes: [] as { method: string; path: string; body: Record<string, unknown> | null }[],
  }
  await page.route('**/api/recipe-schedules', (route) => route.fulfill({ json: { items: [] } }))
  await page.route('**/api/routines', (route) =>
    route.fulfill({ json: { items: state.jobs, unreadable: [] } }),
  )
  await page.route('**/api/routines/**', async (route) => {
    const request = route.request()
    const path = decodeURIComponent(new URL(request.url()).pathname)
    const body = request.postDataJSON() as Record<string, unknown> | null
    state.writes.push({ method: request.method(), path, body })
    const id = path.split('/')[3]!
    const found = state.jobs.find((item) => item.id === id)!
    if (request.method() === 'PATCH') {
      Object.assign(found, body)
      return route.fulfill({ json: found })
    }
    if (request.method() === 'DELETE') {
      state.jobs = state.jobs.filter((item) => item.id !== id)
      return route.fulfill({ json: {} })
    }
    return route.fulfill({ json: {} })
  })
  await page.route('**/api/agents/*/routines', async (route) => {
    const request = route.request()
    if (request.method() !== 'POST') return route.fallback()
    const agentId = new URL(request.url()).pathname.split('/')[3]!
    const body = request.postDataJSON() as Record<string, unknown>
    state.writes.push({ method: 'POST', path: `/api/agents/${agentId}/routines`, body })
    const made = job(`${agentId}:new`, agentId, {
      title: body.title,
      schedule: body.schedule,
      description: body.prompt,
    })
    state.jobs.push(made)
    return route.fulfill({ status: 201, json: made })
  })
  return state
}

test('the list, a filter, an edit that sends only the change, and a new job', async ({ page }) => {
  const state = await mockRepeating(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/b/tasks/repeating')
  const nav = page.getByRole('navigation', { name: 'Tasks views' })
  await expect(nav.getByRole('link', { name: 'Repeating' })).toHaveAttribute('aria-current', 'page')
  const table = page.getByRole('table')
  await expect(table.getByText('Every day, 08:00')).toBeVisible()
  await expect(table.getByText('Fridays, 17:00')).toBeVisible()
  await expect(table.getByText('deep · pinned')).toBeVisible()

  await page
    .getByRole('group', { name: 'Assigned to' })
    .getByRole('button', { name: /^lead · 1/ })
    .click()
  await expect(table.getByText('Morning summary')).toHaveCount(0)
  await page
    .getByRole('group', { name: 'Assigned to' })
    .getByRole('button', { name: /^Everyone/ })
    .click()

  await page.getByRole('button', { name: 'Edit Morning summary' }).click()
  const panel = page.getByRole('complementary', { name: 'Edit Morning summary' })
  await panel.getByLabel('Title').fill('Morning digest')
  await panel.getByRole('button', { name: 'Save' }).click()
  await expect(panel).toHaveCount(0)
  expect(state.writes.filter((write) => write.method === 'PATCH')).toEqual([
    { method: 'PATCH', path: '/api/routines/builder:r1', body: { title: 'Morning digest' } },
  ])

  await page.getByRole('button', { name: 'New repeating job' }).click()
  const fresh = page.getByRole('complementary', { name: 'New repeating job' })
  await fresh.getByLabel('Title').fill('Dependency check')
  await fresh.getByLabel('What it does').fill('Look for old packages')
  await fresh.getByRole('radio', { name: 'Weekdays' }).click()
  await fresh.getByRole('button', { name: 'Save' }).click()
  await expect(fresh).toHaveCount(0)
  const created = state.writes.find((write) => write.method === 'POST')!
  expect(created.body).toMatchObject({ title: 'Dependency check', schedule: '0 8 * * 1-5' })
})

test('Delete… asks first, then removes the job', async ({ page }) => {
  const state = await mockRepeating(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/b/tasks/repeating')
  await page.getByRole('button', { name: 'Edit Weekly report' }).click()
  const panel = page.getByRole('complementary', { name: 'Edit Weekly report' })
  await panel.getByRole('button', { name: 'Delete…' }).click()
  await expect(panel.getByText('Delete “Weekly report”?')).toBeVisible()
  expect(state.writes.filter((write) => write.method === 'DELETE')).toHaveLength(0)
  await panel.getByRole('button', { name: 'Delete it' }).click()
  await expect(page.getByRole('table').getByText('Weekly report')).toHaveCount(0)
  expect(state.writes.filter((write) => write.method === 'DELETE')).toHaveLength(1)
})

test('on a phone the list is cards and the panel a full-height sheet with 44px controls', async ({
  page,
}) => {
  await mockRepeating(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/b/tasks/repeating')
  await expect(page.getByRole('table')).toHaveCount(0)
  await expect(page.getByText('Morning summary')).toBeVisible()
  const edit = page.getByRole('button', { name: 'Edit Morning summary' })
  expect((await edit.boundingBox())!.height).toBeGreaterThanOrEqual(44)
  const tab = page
    .getByRole('navigation', { name: 'Tasks views' })
    .getByRole('link', { name: 'Recipes' })
  expect((await tab.boundingBox())!.height).toBeGreaterThanOrEqual(44)
  await edit.click()
  const sheet = page.getByRole('dialog', { name: 'Edit Morning summary' })
  await expect(sheet).toBeVisible()
  expect((await sheet.boundingBox())!.height).toBeGreaterThanOrEqual(840)
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  )
  expect(overflow).toBeLessThanOrEqual(0)
})
