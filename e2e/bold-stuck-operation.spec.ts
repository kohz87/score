import { expect, test, type Page } from '@playwright/test'
import { holdLockPerTest } from './locks.ts'
import { pair } from './pair.ts'

// 2.0.6: an agent whose create stopped partway (a step failed, Retry is possible) says so on its page, with Retry
// there; Remove agent… shows the same Retry instead of a dead button. The roster and the operation are mocked with
// page.route over the fake adapter; nothing is written.
test.use({ reducedMotion: 'reduce' })
holdLockPerTest('roster')

const sizes = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
] as const

const opId = '0f7b3e0e-6c1c-4a54-9f5a-7a1d0b7a1111'
const incarnationId = '0f7b3e0e-6c1c-4a54-9f5a-7a1d0b7a2222'
const id = 'stuck-g3'

type Mock = { stopped: boolean; retries: number; previews: number }

async function mockStuck(page: Page): Promise<Mock> {
  const mock: Mock = { stopped: true, retries: 0, previews: 0 }
  const lifecycle = () => ({
    state: mock.stopped ? 'needs_attention' : 'ready',
    incarnationId,
    operationId: opId,
  })
  const operation = () => ({
    id: opId,
    kind: 'create',
    targetName: id,
    incarnationId,
    requestHash: 'h',
    state: mock.stopped ? 'needs_attention' : 'completed',
    steps: [
      { name: 'create_profile', state: 'completed' },
      { name: 'model', state: mock.stopped ? 'pending' : 'completed' },
    ],
    createdAt: '2026-10-25T00:00:00.000Z',
    updatedAt: '2026-10-25T00:00:00.000Z',
    nextStep: mock.stopped ? 'model' : null,
    error: mock.stopped ? 'The model could not be set.' : null,
    exportPath: null,
    retryable: mock.stopped,
  })
  await page.route('**/api/agents', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    const response = await route.fetch()
    const body = (await response.json()) as { items: Record<string, unknown>[] }
    body.items.push({
      ...body.items[0]!,
      id,
      name: id,
      role: 'Stopped partway',
      status: 'idle',
      activity: null,
      lifecycle: lifecycle(),
    })
    await route.fulfill({ response, json: body })
  })
  await page.route(`**/api/agents/${id}`, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    const first = (await (await page.request.get('/api/agents')).json()) as {
      items: { id: string }[]
    }
    const real = first.items.find((agent) => agent.id !== id)!
    const response = await route.fetch({
      url: route.request().url().replace(`/agents/${id}`, `/agents/${real.id}`),
    })
    const body = (await response.json()) as Record<string, unknown>
    await route.fulfill({
      response,
      json: { ...body, id, name: id, role: 'Stopped partway', lifecycle: lifecycle() },
    })
  })
  await page.route('**/api/agents/operations/**', async (route) => {
    const url = route.request().url()
    if (url.endsWith('/retry')) {
      mock.retries += 1
      mock.stopped = false
    }
    await route.fulfill({ json: operation() })
  })
  await page.route('**/api/agents/preview', async (route) => {
    mock.previews += 1
    await route.fulfill({
      json: {
        kind: 'delete',
        targetName: id,
        hash: 'p',
        inherited: {
          memories: [],
          skills: [],
          plugins: [],
          approvalSettings: [],
          credentialsPresent: [],
        },
        effects: [],
        blockers: mock.stopped ? ['An operation already holds this agent.'] : [],
        pendingWork: {
          activeRuns: 0,
          queuedTurns: 0,
          pendingApprovals: 0,
          assignments: 0,
          disposition: 'Nothing is running.',
        },
        exportPath: '/tmp/stuck-g3.tar',
      },
    })
  })
  return mock
}

for (const viewport of sizes) {
  const where = `${viewport.width}×${viewport.height}`

  test(`a stopped setup shows its status card with Retry on the agent page at ${where}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport)
    await pair(page)
    const mock = await mockStuck(page)
    await page.goto('/?ui=bold')
    await page.goto(`/b/team/${id}`)
    const card = page.getByLabel(`${id} status`)
    await expect(card).toBeVisible()
    await expect(card).toHaveAttribute('data-protected', 'block')
    await expect(card).toContainText(`Setting up ${id} stopped at Set model`)
    await expect(card.getByRole('alert')).toContainText('The model could not be set.')
    const fits = await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    )
    expect(fits).toBe(true)
    await card.getByRole('button', { name: 'Retry: Set model' }).click()
    await expect(card).toBeHidden()
    expect(mock.retries).toBe(1)
  })

  test(`Remove agent… offers the stopped step's Retry, then Remove works at ${where}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport)
    await pair(page)
    const mock = await mockStuck(page)
    await page.goto('/?ui=bold')
    await page.goto(`/b/team/${id}`)
    await page.getByRole('button', { name: 'Remove agent…' }).click()
    const panel = page.getByRole('group', { name: `Remove ${id}` })
    await expect(panel.getByText('Finish or retry the stopped step first:')).toBeVisible()
    await expect(panel.getByRole('button', { name: 'Remove', exact: true })).toBeHidden()
    await panel.getByRole('button', { name: 'Retry: Set model' }).click()
    await expect(panel.getByLabel(`Type ${id} to confirm`)).toBeVisible()
    await expect(panel.getByRole('button', { name: 'Remove', exact: true })).toBeVisible()
    expect(mock.previews).toBe(2)
  })
}
