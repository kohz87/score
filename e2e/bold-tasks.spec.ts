import { expect, test, type Page } from '@playwright/test'
import { pair } from './pair.ts'

// 3.16.0: the Tasks board in the bold shell. The board's reads are pinned to contract-shaped fixtures (the fake's
// Kanban board moves over time); the shell, pairing, agents and the stream stay real.
test.use({ reducedMotion: 'reduce' })

const sizes = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
] as const

const at = (minute: number) => `2026-11-02T10:${String(minute).padStart(2, '0')}:00.000Z`

function task(id: string, key: string, patch: Record<string, unknown> = {}) {
  return {
    id,
    key,
    title: `Task ${key}`,
    column: 'working',
    hermesStatus: 'running',
    assignee: 'builder',
    reviewer: 'reviewer',
    roomId: null,
    badge: null,
    progress: null,
    elapsedSec: 840,
    note: null,
    updatedAt: at(10),
    ...patch,
  }
}

const tasks = [
  task('t-plan', 'T-41', { column: 'planned', assignee: 'designer', elapsedSec: null }),
  task('t-work', 'T-38', { progress: 0.6 }),
  task('t-lead', 'T-46', { assignee: 'lead', updatedAt: at(9) }),
  task('t-review', 'T-39', { column: 'in_review', assignee: 'lead', reviewer: 'reviewer' }),
  task('t-block', 'T-40', {
    column: 'needs_you',
    badge: { kind: 'blocked', label: 'Needs a token' },
  }),
  task('t-done', 'T-30', { column: 'done' }),
]

async function mockTasks(page: Page) {
  const posts: string[] = []
  await page.route('**/api/tasks**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (request.method() === 'GET' && path === '/api/tasks') {
      const columns: Record<string, unknown[]> = {
        planned: [],
        working: [],
        in_review: [],
        needs_you: [],
        done: [],
      }
      for (const item of tasks) columns[item.column]!.push(item)
      return route.fulfill({ json: { asOfSeq: 1, columns } })
    }
    if (request.method() === 'GET') {
      const id = path.split('/').pop()
      const summary = tasks.find((item) => item.id === id)
      return route.fulfill({
        json: {
          ...summary,
          body: '',
          createdBy: 'you',
          steps: [
            { id: 's1', text: 'Reproduce it', done: true },
            { id: 's2', text: 'Fix it', done: false },
          ],
          activity: [],
          pendingApproval: null,
          dependsOn: [],
          blocks: [],
          runIds: [],
        },
      })
    }
    if (request.method() === 'POST') {
      posts.push(path)
      return route.fulfill({ json: { ok: true } })
    }
    return route.continue()
  })
  return posts
}

for (const size of sizes) {
  test.describe(`${size.width}x${size.height}`, () => {
    test.use({ viewport: size })
    const phone = size.width < 600

    test('Tasks opens from the top bar, shows the columns, a task and the filters', async ({
      page,
    }) => {
      await mockTasks(page)
      await pair(page)
      await page.goto('/b')
      await page.locator('header.top').getByRole('button', { name: 'Tasks', exact: true }).click()
      await expect(page).toHaveURL(/\/b\/tasks$/)
      await expect(page.getByRole('heading', { name: 'Tasks', level: 1 })).toBeVisible()
      await expect(page.getByText('1 need you')).toHaveAttribute('data-protected', 'inline-flex')
      if (phone) {
        await expect(page.getByRole('region', { name: 'Needs you' })).toContainText('Task T-40')
        await page.getByRole('tab', { name: /^Planned/ }).click()
        await page.getByRole('button', { name: /T-41/ }).click()
        const sheet = page.getByRole('dialog', { name: 'Task details' })
        await expect(sheet).toContainText('Reproduce it')
        await sheet.getByRole('button', { name: 'Close task details' }).click()
        await expect(sheet).toBeHidden()
      } else {
        for (const name of ['Planned', 'Working', 'In review', 'Needs you', 'Done'])
          await expect(page.getByRole('region', { name, exact: true })).toBeVisible()
        await page.getByRole('button', { name: /T-38/ }).click()
        const panel = page.getByRole('complementary', { name: 'Task details' })
        await expect(panel).toContainText('Reproduce it')
        await expect(panel).toContainText('Hermes: running')
        await page.getByRole('button', { name: /T-40/ }).click()
        await expect(panel.getByRole('button', { name: 'Unblock' })).toBeVisible()
        const filter = page.getByRole('group', { name: 'Filter by agent' })
        await filter.getByRole('button', { name: 'lead' }).click()
        await expect(page.getByRole('button', { name: /T-46/ })).toBeVisible()
        await expect(page.getByRole('button', { name: /T-38/ })).toHaveCount(0)
      }
    })

    test('the old /tasks address lands on the board', async ({ page }) => {
      await mockTasks(page)
      await pair(page)
      await page.goto('/tasks')
      await expect(page).toHaveURL(/\/b\/tasks$/)
      await expect(page.getByRole('heading', { name: 'Tasks', level: 1 })).toBeVisible()
    })
  })
}
