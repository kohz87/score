import { expect, test, type Page } from '@playwright/test'
import { fixtureNow } from './now-fixture.ts'
import { orchestrationFixtures } from './orchestration-fixtures.ts'
import { okValidation, workflowFixtures } from './workflow-fixtures.ts'
import { teamRoomFixtures } from './team-room-fixture.ts'
import { visualFixtures, visualHello } from './visual-fixtures.ts'

// Baselines for the two kinds of run in the Runs side panel (ported from orchestration-visual and workflow-visual,
// 2.0.x), from frozen fixtures: the orchestration caught with one step done, one running and one waiting for the
// person, and the workflow run caught at its gate. The Steps thread, then the Graph tab.

test.use({ timezoneId: 'UTC', locale: 'en-GB', reducedMotion: 'reduce' })

test.beforeEach(async ({ page }) => {
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
    url.searchParams.delete('tz')
    const key = `${url.pathname}${url.search}`
    const fixture = {
      ...visualFixtures,
      ...teamRoomFixtures,
      ...workflowFixtures,
      ...orchestrationFixtures,
    }[key]
    if (fixture === undefined) {
      await route.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'none' } } })
      return
    }
    await route.fulfill({ json: fixture })
  })
})

const runs = [
  { name: 'orchestration', brief: 'brief-orch-1', node: 's2', widths: [1440, 390] },
  { name: 'workflow', brief: 'brief-wfrun-1', node: 'approve', widths: [1440, 768, 390] },
] as const

const noSideScroll = async (page: Page) =>
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  ).toBeLessThanOrEqual(1)

for (const run of runs) {
  for (const width of run.widths) {
    test(`the ${run.name} run, steps and graph, at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.goto(`/b?run=${run.brief}`)
      await expect(page.getByRole('list', { name: 'Steps' })).toBeVisible()
      await expect(page.getByText(/^Loading the run/)).toHaveCount(0)
      await page.evaluate(() => document.fonts.ready)
      if (width <= 768) await noSideScroll(page)
      await expect(page).toHaveScreenshot(`bold-${run.name}-steps-${width}.png`, {
        animations: 'disabled',
        maxDiffPixelRatio: 0.005,
      })
      await page.getByRole('tab', { name: 'Graph' }).click()
      // 3.15: a lead-decides job's Graph tab is the Job map; a workflow run keeps its step diagram.
      if (run.name === 'orchestration') {
        const map = page.getByRole('region', { name: 'Job map' })
        await expect(map).toBeVisible()
        await map.scrollIntoViewIfNeeded()
      } else {
        await expect(page.locator(`[data-node="${run.node}"]`)).toBeVisible()
        // The panel scrolls inside the page: bring the diagram into the baseline.
        await page.locator('.orch-diagram').scrollIntoViewIfNeeded()
      }
      await page.evaluate(() => document.fonts.ready)
      if (width <= 768) await noSideScroll(page)
      await expect(page).toHaveScreenshot(`bold-${run.name}-graph-${width}.png`, {
        animations: 'disabled',
        maxDiffPixelRatio: 0.005,
      })
    })
  }
}

// The kept classic cards' buttons must be the shell's pills, not square classic buttons.
test('the run page buttons (Pause, Stop, Approve, Reject) are pills', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/b?run=brief-orch-1')
  await expect(page.getByRole('list', { name: 'Steps' })).toBeVisible()
  const buttons = page.locator(
    '.bold-run-classic .orch-controls button, .bold-run-classic .orch-actions button',
  )
  await expect(buttons.first()).toBeVisible()
  const count = await buttons.count()
  expect(count).toBeGreaterThanOrEqual(3)
  for (let i = 0; i < count; i++) {
    const radius = await buttons.nth(i).evaluate((el) => getComputedStyle(el).borderTopLeftRadius)
    expect(radius).toBe('999px')
  }
})
