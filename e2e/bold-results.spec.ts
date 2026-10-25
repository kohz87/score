import { expect, test, type Page } from '@playwright/test'
import { pair } from './pair.ts'
import { visualHello } from './visual-fixtures.ts'

// PLAN 11.5: the seeded team room's Results at the two review sizes, with reduced motion. The fake demo moves on over
// time, so the assertions use the seeded jobs' stable content rather than transient status or timestamps.

const sizes = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'phone', width: 390, height: 844 },
] as const

type Size = (typeof sizes)[number]
type TeamRoom = { room: { id: string; name: string }; jobs: { id: string; title: string }[] }

async function teamRoom(page: Page): Promise<TeamRoom> {
  await expect
    .poll(async () => (await page.request.get('/api/team-room')).status(), { timeout: 30_000 })
    .toBe(200)
  return (await (await page.request.get('/api/team-room')).json()) as TeamRoom
}

async function activityFeedJob(page: Page) {
  const job = (await teamRoom(page)).jobs.find((item) => item.title === 'Activity feed')
  expect(job, 'the fake team room seeds the Activity feed job').toBeDefined()
  return job!
}

async function openResults(page: Page, size: Size, path = '/b') {
  await page.setViewportSize({ width: size.width, height: size.height })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto(path)
  await expect(page.locator('[data-ui="bold"]')).toBeVisible()
  if (size.width < 861) await page.getByRole('button', { name: 'Open side panel' }).click()

  const panel = page.getByRole('complementary', { name: 'Side panel' })
  await expect(panel).toBeVisible()
  const work = panel.getByRole('navigation', { name: 'How to see the work' })
  await expect(work.getByText('Results', { exact: true })).toHaveAttribute('aria-current', 'page')
  await expect(panel.getByRole('tablist')).toHaveCount(0)
  await expect(panel.getByTestId('bold-results')).toBeVisible()
  return panel
}

for (const size of sizes) {
  test.describe(size.name, () => {
    test('shows the seeded change, live preview, draft and screens without raw code', async ({
      page,
    }) => {
      await pair(page)
      const panel = await openResults(page, size)

      const change = panel.locator('[data-card="change"]').filter({ hasText: 'Activity feed' })
      await expect(change).toContainText('What changed')
      await expect(change).toContainText('Activity feed')
      await expect(change).toContainText('Events in the same millisecond get skipped.')
      await expect(change).toContainText('reviewer caught this')
      await expect(change).not.toContainText('api/events.py')
      await expect(change.getByRole('link', { name: 'See the code · 2 files' })).toHaveAttribute(
        'href',
        /^\/b\?job=.+&work=code$/,
      )

      const preview = panel.locator('[data-card="preview"]')
      await expect(preview.getByRole('heading', { name: 'Activity feed' })).toBeVisible()
      await expect(preview).toContainText('Live preview')
      await expect(preview).toContainText('http://localhost:5173/feed')
      await expect(
        preview.getByRole('link', { name: 'Open Activity feed in the Workbench' }),
      ).toHaveAttribute('href', /^\/b\?job=.+&work=screen$/)

      const draft = panel
        .locator('[data-card="draft"]')
        .filter({ hasText: 'Announcement image.md' })
      await expect(draft.getByRole('heading', { name: 'Announcement image.md' })).toBeVisible()
      await expect(draft).toContainText('Release notes 2.4')
      await expect(draft).toContainText('Attached document')
      await expect(draft).not.toContainText('Saved to the Library')
      await expect(draft.getByRole('link', { name: 'Open the draft' })).toHaveAttribute(
        'href',
        /^\/b\?job=.+&work=draft$/,
      )

      const screens = panel.getByRole('region', { name: 'Screens' })
      await expect(screens.getByRole('link', { name: 'Watch builder’s screen' })).toBeVisible()
      await expect(screens).toContainText('builder')
      await expect(screens.getByRole('link', { name: 'Watch builder’s screen' })).toHaveAttribute(
        'href',
        /^\/b\?job=.+&work=screen$/,
      )

      const running = await panel.getByTestId('bold-results').evaluate((root) =>
        root
          .getAnimations({ subtree: true })
          .filter((animation) => animation.playState === 'running')
          .map((animation) => (animation as CSSAnimation).animationName ?? 'transition'),
      )
      expect(running).toEqual([])

      if (size.width < 861) {
        const box = await panel.boundingBox()
        expect(box).not.toBeNull()
        expect(box!.x).toBeGreaterThanOrEqual(0)
        expect(box!.x + box!.width).toBeLessThanOrEqual(size.width + 0.5)
      }
    })

    test('a fresh team room shows the empty state', async ({ page }) => {
      await pair(page)
      const team = await teamRoom(page)
      await page.route('**/api/team-room', (route) =>
        route.fulfill({ json: { asOfSeq: 1, room: team.room, jobs: [] } }),
      )
      await page.route('**/api/rooms/*/jobs**', (route) =>
        route.fulfill({ json: { asOfSeq: 1, items: [] } }),
      )
      const panel = await openResults(page, size)
      await expect(panel.getByRole('heading', { name: 'Nothing being made yet' })).toBeVisible()
    })

    test('a failed Results request shows Retry and loads after it', async ({ page }) => {
      await pair(page)
      const job = await activityFeedJob(page)
      let attempts = 0
      await page.route(`**/api/jobs/${job.id}/results`, async (route) => {
        attempts += 1
        if (attempts === 1) {
          await route.fulfill({
            status: 503,
            json: { error: { code: 'unavailable', message: 'Try later' } },
          })
          return
        }
        const response = await route.fetch()
        await route.fulfill({ response })
      })
      const panel = await openResults(page, size, `/b?job=${encodeURIComponent(job.id)}`)
      const alert = panel.getByRole('alert')
      await expect(alert).toContainText('Couldn’t load the Results')
      await alert.getByRole('button', { name: 'Retry' }).click()
      await expect(panel.locator('[data-card="change"]').getByText('What changed')).toBeVisible()
      await expect(panel.getByRole('alert')).toHaveCount(0)
    })

    test('a new watch frame refreshes the Results content', async ({ page }) => {
      await pair(page)
      const job = await activityFeedJob(page)
      let refreshed = false
      let resultsCalls = 0
      await page.route(`**/api/jobs/${job.id}/results`, async (route) => {
        resultsCalls += 1
        const response = await route.fetch()
        const body = await response.json()
        if (refreshed)
          body.items = body.items.map((item: { kind: string; title?: string }) =>
            item.kind === 'preview' ? { ...item, title: 'Activity feed after refresh' } : item,
          )
        await route.fulfill({
          status: response.status(),
          headers: { ...response.headers(), 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      })

      const hello = `event: stream.hello\ndata: ${JSON.stringify(visualHello)}\n\n`
      const frame = {
        seq: 48,
        at: '2026-10-24T10:00:00.000Z',
        agentId: 'builder',
        runId: 'e2e-results-refresh',
        surface: 'terminal',
        terminal: { cwd: '~/app', command: 'pnpm test', output: 'ok', status: 'ok' },
        caption: 'Ran the results tests',
      }
      let stream = hello
      await page.route('**/api/stream**', (route) =>
        route.fulfill({ contentType: 'text/event-stream', body: stream }),
      )
      const panel = await openResults(page, size, `/b?job=${encodeURIComponent(job.id)}`)
      await expect(panel.getByRole('heading', { name: 'Activity feed' })).toBeVisible()
      const before = resultsCalls
      refreshed = true
      // Stream events are envelopes { seq, ts, type, data }, as the hub sends them.
      const envelope = { seq: 48, ts: frame.at, type: 'watch.frame', data: frame }
      stream = `${hello}event: watch.frame\nid: 48\ndata: ${JSON.stringify(envelope)}\n\n`
      await expect(panel.getByRole('heading', { name: 'Activity feed after refresh' })).toBeVisible(
        { timeout: 20_000 },
      )
      expect(resultsCalls).toBeGreaterThan(before)
    })

    test('switching Library and Results keeps both working', async ({ page }) => {
      await pair(page)
      const panel = await openResults(page, size)
      await expect(
        panel.locator('[data-card="change"]').filter({ hasText: 'Activity feed' }),
      ).toBeVisible()

      await panel.locator('button.side-toggle').click()
      await page.getByRole('button', { name: /^Library/ }).click()
      const library = page.getByTestId('bold-library')
      await expect(library).toBeVisible()
      await expect(library.getByRole('button', { name: 'New note' })).toBeVisible()
      await expect(panel.getByTestId('bold-results')).toBeHidden()

      await page.getByRole('button', { name: /^Library/ }).click()
      await page.getByRole('button', { name: /^Work What/ }).click()
      await expect(panel.getByTestId('bold-results')).toBeVisible()
      await expect(
        panel.locator('[data-card="change"]').filter({ hasText: 'Activity feed' }),
      ).toBeVisible()
    })

    test('Workbench keeps the selected job and note, and has a visible focus target', async ({
      page,
    }) => {
      await pair(page)
      const job = await activityFeedJob(page)
      const panel = await openResults(
        page,
        size,
        `/b?job=${encodeURIComponent(job.id)}&note=Projects%2FRoadmap.md`,
      )
      const work = panel.getByRole('navigation', { name: 'How to see the work' })
      const link = work.getByRole('link', { name: 'Workbench' })
      // The Work nav is Results then Workbench (11.6b): Tab reaches Results first, then Workbench.
      await work.getByRole('link', { name: 'Results' }).focus()
      await page.keyboard.press('Tab')
      await expect(link).toBeFocused()
      expect(await link.evaluate((element) => element.matches(':focus-visible'))).toBe(true)
      await expect
        .poll(() => link.evaluate((element) => getComputedStyle(element).outlineStyle))
        .toBe('solid')
      if (size.width < 861) {
        const box = await link.boundingBox()
        expect(box).not.toBeNull()
        expect(box!.height).toBeGreaterThanOrEqual(44)
      }

      await link.click()
      await expect
        .poll(() => {
          const url = new URL(page.url())
          return [
            url.pathname,
            url.searchParams.get('job'),
            url.searchParams.get('note'),
            url.searchParams.get('work'),
          ]
        })
        .toEqual(['/b', job.id, 'Projects/Roadmap.md', 'workbench'])
      await expect(
        panel.locator('[data-card="change"]').filter({ hasText: 'Activity feed' }),
      ).toBeVisible()
      await expect(panel.locator('[data-card="draft"]')).toHaveCount(0)
    })
  })
}
