import { expect, test, type Page } from '@playwright/test'
import { fixtureNow } from './now-fixture.ts'
import { visualFixtures, visualHello } from './visual-fixtures.ts'
import { watchApprovalFixture, watchFixture, watchOverviewFixture } from './watch-fixture.ts'

test.use({ timezoneId: 'UTC', locale: 'en-GB' })

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
  '/api/approvals?status=all': {
    asOfSeq: 1,
    items: [watchApprovalFixture],
    nextCursor: null,
  },
}
const posts: string[] = []

test.beforeEach(async ({ page }) => {
  posts.length = 0
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
    if (route.request().method() === 'POST') {
      posts.push(url.pathname)
      await route.fulfill({
        json: {
          ...watchFixture.agent,
          status: url.pathname.endsWith('/pause') ? 'paused' : 'working',
        },
      })
      return
    }
    const fixture = fixtures[`${url.pathname}${url.search}`]
    expect(fixture, `Missing fixture: ${url.pathname}${url.search}`).toBeDefined()
    await route.fulfill({ json: fixture })
  })
})

async function open(page: Page, width = 1440) {
  await page.setViewportSize({ width, height: 1100 })
  await page.goto('/watch/builder')
  await expect(page.getByRole('heading', { name: 'Watching builder', level: 1 })).toBeVisible()
  await expect(page.getByText(/^Loading/)).toHaveCount(0)
  await page.evaluate(() => document.fonts.ready)
}

test('the watch page matches the design layout', async ({ page }) => {
  await open(page)
  await expect(page.getByText('You’re watching. builder is in control.')).toBeVisible()
  await expect(page.getByRole('group', { name: 'Approval needed' })).toContainText(
    'npm install ws@8',
  )
  await expect(page.getByRole('button', { name: /Take control/ })).toHaveCount(0)
  await expect(page).toHaveScreenshot('watch-1440.png', {
    fullPage: true,
    animations: 'disabled',
    maxDiffPixelRatio: 0.005,
  })
})

test('the watch page fits a phone', async ({ page }) => {
  await open(page, 390)
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  ).toBeLessThanOrEqual(1)
  await expect(page.getByRole('group', { name: 'Terminal' })).toBeVisible()
})

test('scrub back to an earlier moment, replay it, and snap back to live', async ({ page }) => {
  await open(page)
  const timeline = page.getByRole('group', { name: 'Replay timeline' })
  const markers = timeline.getByRole('button')
  await expect(markers).toHaveCount(watchFixture.markers.length)
  await expect(page.getByRole('button', { name: 'Back to live' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )

  // The editor frame (second marker): the stage shows that moment, the approval bar steps aside.
  await markers.nth(1).click()
  await expect(page.getByText('Replaying 21:21')).toBeVisible()
  await expect(page.getByRole('group', { name: 'Editor' })).toHaveAttribute('data-front', 'true')
  await expect(page.getByRole('group', { name: 'Editor' })).toContainText('WHERE (created_at, id)')
  await expect(page.getByRole('group', { name: 'Approval needed' })).toHaveCount(0)
  // Windows that did not exist yet are not on screen.
  await expect(page.getByRole('group', { name: 'Browser' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Back to live' })).toHaveAttribute(
    'aria-pressed',
    'false',
  )

  // Keyboard: arrows move between markers, End returns to live.
  await page.keyboard.press('ArrowRight')
  await expect(page.getByRole('group', { name: 'Browser' })).toHaveAttribute('data-front', 'true')
  await page.keyboard.press('ArrowLeft')
  await expect(page.getByRole('group', { name: 'Editor' })).toHaveAttribute('data-front', 'true')
  await page.keyboard.press('End')
  await expect(page.getByText('You’re watching. builder is in control.')).toBeVisible()
  await expect(page.getByRole('group', { name: 'Approval needed' })).toBeVisible()

  // Dragging along the track replays too, and the Live button snaps back.
  const box = (await timeline.boundingBox())!
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.06, box.y + box.height / 2, { steps: 4 })
  await page.mouse.up()
  await expect(page.getByText(/^Replaying /)).toBeVisible()
  await page.getByRole('button', { name: 'Back to live' }).click()
  await expect(page.getByText('You’re watching. builder is in control.')).toBeVisible()

  // Back 30 seconds, then pick an item from "What builder is doing".
  await page.getByRole('button', { name: 'Back 30 seconds' }).click()
  await expect(page.getByText(/^Replaying /)).toBeVisible()
  await page.getByRole('button', { name: /Ran the event tests/ }).click()
  await expect(page.getByText('Replaying 21:28')).toBeVisible()
  await page.getByRole('button', { name: 'Back to live' }).click()
})

test('pause the agent and copy the command that opens its session', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await open(page)
  await page.getByRole('button', { name: 'Pause builder' }).click()
  await expect.poll(() => posts).toContain('/api/agents/builder/pause')
  await page.getByRole('button', { name: 'Open in terminal' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Copied' })).toContainText(
    'hermes -p builder --resume score-room-activity-feed-builder',
  )
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    'hermes -p builder --resume score-room-activity-feed-builder',
  )
})

test('approving from the watch bar answers the approval', async ({ page }) => {
  await open(page)
  await page
    .getByRole('group', { name: 'Approval needed' })
    .getByRole('button', { name: 'Approve' })
    .click()
  await expect.poll(() => posts).toContain(`/api/approvals/${watchApprovalFixture.id}/decision`)
})
