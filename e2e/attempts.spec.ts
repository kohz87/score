import { expect, test, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { nowFixture } from './now-fixture.ts'

// Runs against its own fake-adapter server with SCORE_KANBAN_ATTEMPTS=1 and seeded attempts (playwright.config.ts;
// seed: apps/server/src/hermes/fake/attempts-seed.ts). Every other spec runs with the flag off.
test.describe.configure({ mode: 'serial' })
test.use({ viewport: { width: 1440, height: 1100 }, timezoneId: 'UTC', locale: 'en-GB' })

let page: Page
test.beforeAll(async ({ browser, baseURL }) => {
  const context = await browser.newContext({
    baseURL: baseURL!,
    viewport: { width: 1440, height: 1100 },
    timezoneId: 'UTC',
    locale: 'en-GB',
  })
  page = await context.newPage()
  const log = join(process.env.SCORE_E2E_HOME!, 'attempts.log')
  await expect
    .poll(() => /\/pair#([\w-]+)/.exec(readFileSync(log, 'utf8'))?.[1], { timeout: 30_000 })
    .toBeTruthy()
  const token = /\/pair#([\w-]+)/.exec(readFileSync(log, 'utf8'))![1]
  await page.goto(`/pair#${token}`)
  await expect(page.getByText('This browser is paired')).toBeVisible({ timeout: 15_000 })
})
test.afterAll(async () => {
  await page.context().close()
})

test('Now draws the Unattributed lane, a dashed no-longer-observed tail and opens an earlier board', async () => {
  await page.goto('/now')
  const score = page.getByRole('region', { name: /^Score:/ })
  const lane = score.getByRole('group', { name: 'Unattributed, No known agent' })
  await expect(lane).toBeVisible()
  await expect(
    lane.getByRole('button', { name: /Unattributed: .*provenance unknown/ }),
  ).toBeVisible()
  const lost = score.getByRole('button', { name: /reviewer: .*no longer observed since/ })
  await expect(lost).toBeVisible()
  await expect(lost).toHaveClass(/now-block--unobserved/)
  await expect(score.getByText('No longer observed')).toBeVisible()
  // Attempts have no session: nothing in the Unattributed lane links to Watch.
  await expect(score.locator('a[href*="/now/watch/unattributed"]')).toHaveCount(0)
  await score.getByRole('button', { name: /designer: .*Old board job/ }).click()
  await expect(page).toHaveURL(/\/attempts\/kr_/)
  await expect(page.getByText(/From an earlier copy of the board/)).toBeVisible()
  await expect(page.getByRole('region', { name: 'Task as last observed' })).toContainText(
    'Old board job',
  )
  await expect(page.locator('a[href*="/now/watch/"]')).toHaveCount(0)
})

test('Reports counts Unattributed work and Team history lists the attempts', async () => {
  await page.goto('/reports')
  const table = page.getByRole('table', { name: 'By agent', exact: true })
  await expect(table.locator('tbody th', { hasText: 'Unattributed' })).toBeVisible()
  await expect(page.getByText(/counts attempts with proven evidence only/)).toBeVisible()
  await page.goto('/team/designer')
  await page.getByRole('tab', { name: 'History' }).click()
  const panel = page.getByRole('tabpanel')
  await expect(panel.locator('.team-channel-state', { hasText: 'Failed' })).toBeVisible()
  await expect(panel.getByRole('link', { name: /Open the attempt/ })).toBeVisible()
  await expect(panel.getByRole('link', { name: /Replay/ })).toHaveCount(0)
})

test('Now with an unattributed lane and a dashed tail matches the baseline', async () => {
  const rooms = (await (await page.request.get('/api/rooms')).json()) as { rooms: { id: string }[] }
  const fixture = nowFixture(rooms.rooms[0]?.id ?? 'room-fixture')
  const at = (minutes: number) => new Date(Date.parse(fixture.now) + minutes * 60_000).toISOString()
  const block = (over: object) => ({
    state: 'done',
    taskId: null,
    runId: null,
    kind: 'task',
    provenance: 'proven',
    ...over,
  })
  const snapshot = {
    ...fixture,
    lanes: fixture.lanes.map((lane, index) =>
      index === 3
        ? {
            ...lane,
            blocks: [
              ...lane.blocks,
              block({
                id: 'attempt:kr_lost',
                label: 'Lost track',
                start: at(-55),
                end: null,
                observationEndedAt: at(-38),
                attemptId: 'kr_00000000-0000-4000-8000-000000000099',
                order: [at(-40), 9],
              }),
            ],
          }
        : lane,
    ),
    unattributed: {
      blocks: [
        block({
          id: 'attempt:kr_u1',
          label: 'Unclaimed cleanup',
          start: at(-35),
          end: at(-18),
          provenance: 'partial',
          attemptId: 'kr_00000000-0000-4000-8000-000000000098',
          order: [at(-35), 8],
        }),
      ],
    },
  }
  await page.route('**/api/now', (route) => route.fulfill({ json: snapshot }))
  await page.route('**/api/agents/*/todos', (route) =>
    route.fulfill({ contentType: 'application/json', body: 'null' }),
  )
  await page.goto('/now')
  const score = page.getByRole('region', { name: /^Score:/ })
  await expect(score.getByRole('group', { name: 'Unattributed, No known agent' })).toBeVisible()
  await page.evaluate(() => document.fonts.ready)
  await expect(score).toHaveScreenshot('now-unattributed.png', { maxDiffPixelRatio: 0.01 })
})
