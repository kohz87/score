import { expect, test, type Page } from '@playwright/test'
import {
  AgentSummarySchema,
  TaskSummarySchema,
  type TaskColumn,
  type TaskSummary,
} from '../packages/contract/src/index.ts'

const columns: TaskColumn[] = ['planned', 'working', 'in_review', 'needs_you', 'done']
const at = '2026-10-08T21:31:00.000Z'
const agents = [
  { id: 'lead', color: '#6B4EFF', shape: 'circle-dot' },
  { id: 'builder', color: '#19C39A', shape: 'triangle' },
  { id: 'reviewer', color: '#FFB61E', shape: 'diamond' },
  { id: 'designer', color: '#FF6B8A', shape: 'square' },
].map(({ id, color, shape }) =>
  AgentSummarySchema.parse({
    id,
    name: id,
    role: 'Example agent',
    style: { color, shape },
    status: 'idle',
    activity: null,
    model: null,
    served: true,
  }),
)
function exampleTask(id: string, title: string, overrides: Partial<TaskSummary> = {}): TaskSummary {
  return TaskSummarySchema.parse({
    id,
    key: `T-${id}`,
    title,
    column: 'planned',
    hermesStatus: 'ready',
    assignee: 'builder',
    reviewer: 'reviewer',
    roomId: 'room-feed',
    badge: null,
    progress: null,
    elapsedSec: null,
    note: null,
    updatedAt: at,
    ...overrides,
  })
}
const designTasks = [
  exampleTask('111', 'Sign off the activity feed', { assignee: 'reviewer', note: 'after stream' }),
  exampleTask('112', 'Report back to the team', { assignee: 'lead', note: 'after sign-off' }),
  exampleTask('113', 'Compare vector stores for the wiki', {
    note: 'tomorrow',
    roomId: 'room-research',
  }),
  exampleTask('115', 'Re-review the read layer', {
    column: 'working',
    assignee: 'reviewer',
    progress: 0.6,
    elapsedSec: 360,
  }),
  exampleTask('116', 'Summarize this week’s releases', {
    column: 'working',
    assignee: 'lead',
    progress: 0.35,
    elapsedSec: 840,
    roomId: 'room-research',
  }),
  exampleTask('117', 'Empty and error states', {
    column: 'working',
    assignee: 'designer',
    note: 'queued',
    badge: { kind: 'starts_after', label: 'Starts after review' },
  }),
  exampleTask('118', 'Lorebook export', {
    column: 'in_review',
    badge: { kind: 'changes_requested', label: 'Changes requested' },
  }),
  exampleTask('114', 'Event stream for the activity feed', {
    column: 'needs_you',
    elapsedSec: 60,
    note: 'Wants to install a package',
  }),
  exampleTask('119', 'Read layer for task events', { column: 'done', elapsedSec: 1800 }),
  exampleTask('120', 'Plan the activity feed', {
    column: 'done',
    assignee: 'lead',
    elapsedSec: 1200,
  }),
  exampleTask('121', 'Morning digest', { column: 'done', assignee: 'lead', elapsedSec: 120 }),
]
async function designSnapshots(page: Page) {
  await page.route('**/api/stream*', (route) =>
    route.fulfill({ contentType: 'text/event-stream', body: ': design fixture\n\n' }),
  )
  await page.route('**/api/agents', (route) =>
    route.fulfill({ json: { asOfSeq: 1, items: agents } }),
  )
  await page.route('**/api/rooms', (route) =>
    route.fulfill({
      json: {
        asOfSeq: 1,
        rooms: ['feed', 'research'].map((id) => ({
          id: `room-${id}`,
          name: id === 'feed' ? '#activity-feed' : '#research',
          kind: 'room',
          leadAgentId: 'lead',
          members: agents.map((agent) => agent.id),
          unread: 0,
          activeAgents: [],
          channels: [],
        })),
        directs: [],
      },
    }),
  )
  await page.route(/\/api\/tasks(?:\?.*)?$/, (route) => {
    const params = new URL(route.request().url()).searchParams
    const tasks = designTasks.filter(
      (task) =>
        (!params.get('agent') || task.assignee === params.get('agent')) &&
        (!params.get('room') || task.roomId === params.get('room')) &&
        (params.get('needsYou') !== 'true' || task.column === 'needs_you'),
    )
    return route.fulfill({
      json: {
        asOfSeq: 1,
        columns: Object.fromEntries(
          columns.map((column) => [column, tasks.filter((task) => task.column === column)]),
        ),
      },
    })
  })
}

test('fake adapter tasks render and open with Enter', async ({ page }) => {
  await page.goto('/tasks')
  await expect(page.getByRole('heading', { name: 'Tasks', level: 1 })).toBeVisible()
  const board = page.getByRole('region', { name: 'Tasks board' })
  for (const name of ['Planned', 'Working', 'In review', 'Needs you', 'Done'])
    await expect(board.getByRole('heading', { name, exact: true })).toBeVisible()
  const card = board.getByRole('link', { name: /T-101: Add pagination/ }).first()
  await expect(card).toBeVisible({ timeout: 20_000 })
  await card.focus()
  await card.press('Enter')
  await expect(page).toHaveURL(/\/tasks\/task-pagination-\d+$/)
  await expect(page.getByRole('complementary', { name: 'Task details' })).toBeVisible()
  const close = page.getByRole('link', { name: 'Close details' })
  await expect(close).toBeFocused()
  await close.press('Escape')
  await expect(page).toHaveURL('/tasks')
  await expect(card).toBeFocused()
})

test('design card variants, arrow navigation, filters and placeholder layout', async ({
  page,
}, testInfo) => {
  await designSnapshots(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/tasks')
  const board = page.getByRole('region', { name: 'Tasks board' })
  await expect(board.getByRole('link')).toHaveCount(designTasks.length)
  await expect(
    page.getByRole('progressbar', { name: 'Re-review the read layer progress' }),
  ).toHaveAttribute('aria-valuenow', '60')
  const first = board.getByRole('link', { name: 'T-111: Sign off the activity feed' })
  await first.focus()
  await first.press('ArrowDown')
  const second = board.getByRole('link', { name: 'T-112: Report back to the team' })
  await expect(second).toBeFocused()
  await second.press('ArrowRight')
  const working = board.getByRole('link', { name: 'T-116: Summarize this week’s releases' })
  await expect(working).toBeFocused()
  await working.press('ArrowRight')
  await expect(board.getByRole('link', { name: 'T-118: Lorebook export' })).toBeFocused()
  await board.getByRole('link', { name: 'T-114: Event stream for the activity feed' }).click()
  await page.evaluate(() => document.fonts.ready)
  await page.screenshot({ path: testInfo.outputPath('tasks-desktop.png'), fullPage: true })
  await page.getByRole('link', { name: 'Close details' }).click()
  await page.getByRole('button', { name: 'builder', exact: true }).click()
  await page.getByRole('button', { name: 'Needs you', exact: true }).click()
  await page.getByRole('combobox', { name: 'Room' }).selectOption('room-feed')
  await expect(page).toHaveURL('/tasks?agent=builder&needsYou=true&room=room-feed')
  await expect(board.getByRole('link')).toHaveCount(1)
  await page.reload()
  await expect(page.getByRole('button', { name: 'builder', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(board.getByRole('link')).toHaveCount(1)
})

test('small screens scroll the board without overflowing the page', async ({ page }, testInfo) => {
  await designSnapshots(page)
  await page.setViewportSize({ width: 360, height: 800 })
  await page.goto('/tasks')
  await expect(page.getByRole('region', { name: 'Tasks board' }).getByRole('link')).toHaveCount(
    designTasks.length,
  )
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360)
  const board = page.getByRole('region', { name: 'Tasks board' })
  await board.focus()
  await board.press('ArrowRight')
  await expect.poll(() => board.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0)
  await page.screenshot({ path: testInfo.outputPath('tasks-mobile.png'), fullPage: true })
})
