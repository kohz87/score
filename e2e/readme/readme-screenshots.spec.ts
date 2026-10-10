import { mkdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'
import { fixtureNow } from '../now-fixture.ts'
import { orchestrationFixtures } from '../orchestration-fixtures.ts'
import { okValidation, unfinishedValidation, workflowFixtures } from '../workflow-fixtures.ts'
import { visualFixtures, visualHello } from '../visual-fixtures.ts'
import { taskDetailFixture, tasksFixture } from './tasks-fixture.ts'
import { watchApprovalFixture, watchFixture, watchOverviewFixture } from '../watch-fixture.ts'

// Regenerates docs/screenshots/*.png for the README: `pnpm screenshots`. Every /api call is answered from the e2e
// fixtures (the neutral demo team lead, builder, reviewer, designer), so nothing here can show a real profile, host
// or token. The fixtures are frozen at one moment, so the pictures are the same on every run.
const out = fileURLToPath(new URL('../../docs/screenshots/', import.meta.url))
mkdirSync(out, { recursive: true })

// What the preflight endpoint answers on the demo server (every check ok).
const preflight: unknown = JSON.parse(
  readFileSync(fileURLToPath(new URL('preflight-fixture.json', import.meta.url)), 'utf8'),
)

// The coding CLIs the demo server reports as installed.
const codingRuntimes: unknown = JSON.parse(
  readFileSync(fileURLToPath(new URL('coding-runtimes-fixture.json', import.meta.url)), 'utf8'),
)

const fixtures: Record<string, unknown> = {
  ...visualFixtures,
  '/api/agents/builder/watch?limit=500': watchFixture,
  '/api/agents/builder/watch?limit=1': watchFixture,
  '/api/approvals?status=pending&agent=builder': {
    asOfSeq: 1,
    items: [watchApprovalFixture],
    nextCursor: null,
  },
  '/api/watch/overview': watchOverviewFixture,
  '/api/coding-agents/runtimes': codingRuntimes,
  '/api/coding-agents': { items: [] },
  '/api/tasks': tasksFixture,
  '/api/tasks/task-docs': taskDetailFixture,
}

test.use({ timezoneId: 'UTC', locale: 'en-GB', viewport: { width: 1440, height: 900 } })

// Only the orchestration pictures show a run; everywhere else the team has none.
let withOrchestration = false

test.beforeEach(async ({ page }) => {
  withOrchestration = false
  await page.clock.setFixedTime(new Date(fixtureNow))
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/stream') {
      await route.fulfill({
        contentType: 'text/event-stream',
        body: `event: stream.hello\ndata: ${JSON.stringify(visualHello)}\n\n`,
      })
      return
    }
    if (url.pathname === '/api/workflows/validate') {
      const body = JSON.parse(route.request().postData() ?? '{}') as {
        definition?: { name?: string }
      }
      await route.fulfill({
        json: body.definition?.name?.includes('(draft)') ? unfinishedValidation : okValidation,
      })
      return
    }
    url.searchParams.delete('tz')
    if (url.pathname === '/api/orchestrations/preflight') {
      await route.fulfill({ json: preflight })
      return
    }
    const key = `${url.pathname}${url.search}`
    const fixture =
      withOrchestration && key in orchestrationFixtures
        ? orchestrationFixtures[key]
        : (workflowFixtures[key] ?? fixtures[key])
    if (fixture === undefined) {
      await route.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'none' } } })
      return
    }
    await route.fulfill({ json: fixture })
  })
})

async function settle(page: Page, ready: string) {
  await expect(page.locator(ready).first()).toBeVisible()
  await expect(page.getByText(/^Loading/)).toHaveCount(0)
  await page.evaluate(() => document.fonts.ready)
}

async function shot(page: Page, name: string) {
  await page.screenshot({ path: `${out}${name}.png`, animations: 'disabled' })
}

async function visit(page: Page, path: string, ready: string) {
  await page.goto(path)
  await settle(page, ready)
}

test('now', async ({ page }) => {
  await visit(page, '/now', '.now-cards')
  await shot(page, 'now')
})

test('flow', async ({ page }) => {
  await visit(page, '/now/flow/fixture-flow', '[data-flow-node]')
  await shot(page, 'flow')
})

test('orchestration live', async ({ page }) => {
  withOrchestration = true
  // Taller than the other pictures so the run header, the approval card, the diagram and the log all show.
  await page.setViewportSize({ width: 1440, height: 1660 })
  await visit(page, '/now/flow/brief-orch-1', '[data-node="s2"]')
  await shot(page, 'orchestration')
})

test('new orchestration dialog', async ({ page }) => {
  await visit(page, '/chat', '.chat-files, .chat-sidebar, main')
  await page.getByRole('button', { name: /New orchestration/ }).click()
  const dialog = page.getByRole('dialog', { name: 'New orchestration' })
  await expect(dialog).toBeVisible()
  await dialog
    .getByLabel('Goal')
    .fill('Write the release notes for 2.4 and have them reviewed before Friday.')
  await dialog.getByRole('checkbox', { name: 'builder' }).check()
  await dialog.getByRole('checkbox', { name: 'reviewer' }).check()
  await dialog.getByLabel('Budget in USD (optional)').fill('5')
  await dialog.getByRole('heading', { name: 'New orchestration' }).click()
  await expect(dialog.getByRole('list', { name: 'Preflight checks' })).toBeVisible()
  await shot(page, 'new-orchestration')
})

test('workflow editor', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1100 })
  await visit(page, '/now/flow/workflows/wf-draft', '[data-node="build"]')
  await page.locator('[data-node="build"]').click()
  await shot(page, 'workflow-editor')
})

test('workflow run', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1300 })
  await visit(page, '/now/flow/brief-wfrun-1', '[data-node="approve"]')
  await shot(page, 'workflow-run')
})

test('watch', async ({ page }) => {
  await page.goto('/now/watch/builder')
  await expect(page.getByRole('heading', { name: 'Watching builder', level: 1 })).toBeVisible()
  await settle(page, 'main')
  await shot(page, 'watch')
})

test('chat', async ({ page }) => {
  await visit(page, '/chat/room-activity-feed', '.chat-files')
  await shot(page, 'chat')
})

test('chat on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/chat/room-activity-feed')
  await settle(page, '.chat-scroll')
  // The room list comes first on a phone; show the conversation.
  await page.getByRole('heading', { name: '#activity-feed', level: 1 }).evaluate((element) => {
    window.scrollTo(0, element.getBoundingClientRect().top + window.scrollY - 16)
  })
  await shot(page, 'chat-phone')
})

test('tasks', async ({ page }) => {
  await visit(page, '/tasks', '.task-card')
  await page.locator('a[href="/tasks/task-docs"]').click()
  await expect(page.getByRole('complementary', { name: 'Task details' })).toBeVisible()
  await shot(page, 'tasks')
})

test('team', async ({ page }) => {
  await visit(page, '/team', '.team-agent-card')
  await shot(page, 'team')
})

test('agent', async ({ page }) => {
  await visit(page, '/team/builder', '.team-tabs')
  await shot(page, 'agent')
})

test('add coding agent', async ({ page }) => {
  await visit(page, '/team', '.team-agent-card')
  await page.getByRole('button', { name: 'Add agent' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('radio', { name: /Coding agent/ }).check()
  await expect(dialog.getByLabel('Coding CLI')).toHaveValue('claude-code')
  await dialog.getByLabel(/Agent name/).fill('coder')
  await dialog.getByRole('heading', { name: 'Add agent' }).click()
  await shot(page, 'coding-agent')
})

test('knowledge', async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem('score.knowledge.mode', 'edit'))
  await visit(page, '/knowledge/projects/launch-plan.md', '.cm-lp-table table')
  await shot(page, 'knowledge')
})

test('reports', async ({ page }) => {
  await visit(page, '/reports', '.reports-table tbody tr')
  await shot(page, 'reports')
})

test('settings', async ({ page }) => {
  await visit(page, '/settings', 'text=Models and keys')
  await page.getByRole('link', { name: 'Rules and approvals' }).click()
  await settle(page, '.rules-columns')
  await page.getByRole('heading', { name: 'Rules and approvals', level: 2 }).evaluate((element) => {
    window.scrollTo(0, element.getBoundingClientRect().top + window.scrollY - 40)
  })
  await shot(page, 'settings')
})

test('dark mode', async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem('score.theme', 'dark'))
  await visit(page, '/now', '.now-cards')
  expect(await page.locator('html').getAttribute('data-theme')).toBe('dark')
  await shot(page, 'now-dark')
})
