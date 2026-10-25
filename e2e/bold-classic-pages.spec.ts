import { expect, test, type Page } from '@playwright/test'
import { fixtureNow } from './now-fixture.ts'
import { pair } from './pair.ts'
import { okValidation, workflowFixtures } from './workflow-fixtures.ts'
import { visualFixtures, visualHello } from './visual-fixtures.ts'
import { watchApprovalFixture, watchFixture, watchOverviewFixture } from './watch-fixture.ts'

// 2.0.2 (decision 123): the kept classic pages open inside the new shell. Frozen fixtures, no live adapter.

test.use({ timezoneId: 'UTC', locale: 'en-GB' })

const fixtures: Record<string, unknown> = {
  ...visualFixtures,
  ...workflowFixtures,
  '/api/agents/builder/watch?limit=500': watchFixture,
  '/api/agents/builder/watch?limit=1': watchFixture,
  '/api/approvals?status=pending&agent=builder': {
    asOfSeq: 1,
    items: [watchApprovalFixture],
    nextCursor: null,
  },
  '/api/watch/overview': watchOverviewFixture,
  '/api/approvals?status=all': { asOfSeq: 1, items: [watchApprovalFixture], nextCursor: null },
}

test.beforeEach(async ({ page }, info) => {
  // The Customizer test uses the real fake adapter: it reads and saves themes.
  if (info.title.includes('Customizer')) return
  await page.clock.setFixedTime(new Date(fixtureNow))
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
      await route.fulfill({ json: okValidation })
      return
    }
    if (route.request().method() !== 'GET') {
      await route.fulfill({ json: {} })
      return
    }
    url.searchParams.delete('tz')
    const fixture = fixtures[`${url.pathname}${url.search}`]
    if (fixture === undefined) {
      await route.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'none' } } })
      return
    }
    await route.fulfill({ json: fixture })
  })
})

const sizes = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'phone', width: 390, height: 844 },
] as const

const frame = (page: Page) => page.locator('[data-ui="bold"] .top .word')
const inFrame = async (page: Page) => {
  await expect(frame(page)).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('.app-shell')).toHaveCount(0)
}
const noSideScroll = async (page: Page) =>
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  ).toBeLessThanOrEqual(1)

for (const size of sizes) {
  test.describe(size.name, () => {
    test.use({ viewport: { width: size.width, height: size.height } })

    test(`Recipes opens the workflow list inside the new shell, and Back returns to Recipes at ${size.name}`, async ({
      page,
    }) => {
      await page.goto('/b?recipes=1')
      const link = page.getByRole('link', { name: 'Workflow runs and versions' })
      await expect(link).toBeVisible({ timeout: 20_000 })
      await link.click()
      await expect(page).toHaveURL(/\/b\/workflows$/)
      await inFrame(page)
      await expect(page.locator('.bold-classic-page .wf-card').first()).toBeVisible()
      await noSideScroll(page)
      await expect(page).toHaveScreenshot(`bold-workflows-${size.name}.png`, {
        animations: 'disabled',
        maxDiffPixelRatio: 0.01,
      })
      // A link to another classic page stays in /b.
      await page.locator('.bold-classic-page .wf-card a').first().click()
      await expect(page).toHaveURL(/\/b\/workflows\/wf-[a-z-]+$/)
      await inFrame(page)
      await page.goBack()
      await page.goBack()
      await expect(page).toHaveURL(/\/b\?recipes=1$/)
      await expect(page.getByRole('dialog', { name: 'Recipe editor' })).toBeVisible()
    })

    test(`the workflow editor and a run page open under /b at ${size.name}`, async ({ page }) => {
      await page.goto('/b/workflows/wf-draft')
      await inFrame(page)
      await expect(page.locator('[data-node="build"]')).toBeVisible()
      await noSideScroll(page)
      await expect(page.getByRole('link', { name: 'All workflows' })).toHaveAttribute(
        'href',
        /\/b\/workflows$/,
      )
      await page.goto('/b/runs/brief-wfrun-1')
      await inFrame(page)
      await expect(page.locator('[data-node="approve"]')).toBeVisible()
      await noSideScroll(page)
      await expect(page).toHaveScreenshot(`bold-run-${size.name}.png`, {
        animations: 'disabled',
        maxDiffPixelRatio: 0.01,
      })
    })

    test(`Watch opens under /b at ${size.name}`, async ({ page }) => {
      await page.goto('/b/watch/builder')
      await inFrame(page)
      await expect(page.getByRole('heading', { name: 'Watching builder', level: 1 })).toBeVisible()
      // The approval is a decision surface: still visible and protected inside the frame.
      const approval = page.getByRole('group', { name: 'Approval needed' })
      await expect(approval).toContainText('npm install ws@8')
      await noSideScroll(page)
      await expect(page).toHaveScreenshot(`bold-watch-${size.name}.png`, {
        animations: 'disabled',
        maxDiffPixelRatio: 0.01,
      })
    })
  })
}

for (const size of sizes) {
  test.describe(size.name, () => {
    test.use({ viewport: { width: size.width, height: size.height } })

    test(`the Customizer opens under /b from Look at ${size.name}`, async ({ page }) => {
      await pair(page)
      await page.goto('/b/settings/look')
      const open = page.getByRole('link', { name: 'Open the Customizer' })
      await expect(open).toBeVisible({ timeout: 20_000 })
      await open.click()
      await expect(page).toHaveURL(/\/b\/settings\/look\/customize\/[^/]+$/)
      await inFrame(page)
      await expect(page.getByRole('heading', { name: 'Customize' })).toBeVisible()
      await noSideScroll(page)
      // Its Back link returns to Look inside /b.
      await page.locator('.cz-back').click()
      await expect(page).toHaveURL(/\/b\/settings\/look$/)
    })
  })
}

test('old classic paths on the new shell redirect to /b and keep the query', async ({ page }) => {
  await page.goto('/workflows')
  await expect(page).toHaveURL(/\/b\/workflows$/)
  await page.goto('/runs/brief-wfrun-1?x=1')
  await expect(page).toHaveURL(/\/b\/runs\/brief-wfrun-1\?x=1$/)
  await page.goto('/watch/builder?from=3')
  await expect(page).toHaveURL(/\/b\/watch\/builder\?from=3$/)
  await page.goto('/settings/look/customize/score')
  await expect(page).toHaveURL(/\/b\/settings\/look\/customize\/score$/)
})

test('on the classic view the classic paths still render the classic shell', async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem('score.ui', 'classic'))
  await page.goto('/workflows')
  await expect(page).toHaveURL(/\/workflows$/)
  await expect(page.locator('.app-shell')).toBeVisible()
  await expect(page.locator('[data-ui="bold"]')).toHaveCount(0)
  await page.goto('/runs/brief-wfrun-1')
  await expect(page).toHaveURL(/\/runs\/brief-wfrun-1$/)
  await expect(page.locator('.app-shell')).toBeVisible()
})
