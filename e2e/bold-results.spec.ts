import { expect, test, type Locator, type Page } from '@playwright/test'
import { pair } from './pair.ts'
import { visualHello } from './visual-fixtures.ts'

// PLAN 11.5, moved in 3.25.0: Results folded into Info's "Files and results" (and the viewer sheet). The seeded team room at the two review sizes, with reduced motion. The fake demo moves on over
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

async function openResults(page: Page, size: Size, path = '/b?open=1') {
  await page.setViewportSize({ width: size.width, height: size.height })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  // 3.25.0: Results is Info's "Files and results" section. `?work=results` opens Info at it; on a phone Chat info opens
  // the sheet on Info.
  const phone = size.width < 861
  await page.goto(phone ? path : `${path}${path.includes('?') ? '&' : '?'}work=results`)
  await expect(page.locator('[data-ui="bold"]')).toBeVisible()
  if (phone) await page.getByRole('button', { name: 'Chat info' }).click()

  const panel = page.getByRole('complementary', { name: 'Side panel' })
  await expect(panel).toBeVisible()
  // The panel is Info (| Graph) only: no Results tab and no Results/Workbench switch.
  await expect(panel.getByRole('tab', { name: 'Info' })).toHaveAttribute('aria-selected', 'true')
  await expect(panel.getByRole('tab', { name: 'Results' })).toHaveCount(0)
  await expect(panel.getByRole('navigation', { name: 'How to see the work' })).toHaveCount(0)
  const files = panel.getByTestId('files-results')
  await expect(files).toBeVisible()
  return { panel, files }
}

/** Every row, with "Show all" pressed when the section folds some away. */
async function allRows(files: Locator) {
  const more = files.getByRole('button', { name: /^Show all/ })
  if (await more.count()) await more.click()
}

for (const size of sizes) {
  test.describe(size.name, () => {
    test('shows the seeded files, link, draft and screens without raw code', async ({ page }) => {
      await pair(page)
      const job = await activityFeedJob(page)
      const { files } = await openResults(page, size, `/b?job=${encodeURIComponent(job.id)}`)
      await allRows(files)

      const code = files.locator('[data-files-row="code:api/events.py"]')
      await expect(code).toHaveAttribute('data-kind', 'file')
      await expect(code).toContainText('events.py')
      await expect(code).not.toContainText('api/events.py')
      await expect(code).toHaveAttribute(
        'href',
        /^\/b\?.*job=.+&work=code&file=api%2Fevents\.py|work=code/,
      )
      await expect(code).toContainText('builder')

      const link = files.locator('[data-kind="link"]').filter({ hasText: 'Activity feed' })
      await expect(link).toHaveAttribute('title', 'http://localhost:5173/feed')
      await expect(link).toHaveAttribute('href', /^\/b\?.*work=screen/)

      const screens = files.locator('[data-kind="screen"]')
      await expect(screens.first()).toHaveAttribute('href', /^\/b\?.*work=screen/)
      await expect(files.locator('[data-files-row="screen:builder"]')).toContainText(
        'builder’s screen',
      )

      const running = await files.evaluate((root) =>
        root
          .getAnimations({ subtree: true })
          .filter((animation) => animation.playState === 'running')
          .map((animation) => (animation as CSSAnimation).animationName ?? 'transition'),
      )
      expect(running).toEqual([])

      if (size.width < 861) {
        const box = await files.boundingBox()
        expect(box).not.toBeNull()
        expect(box!.x).toBeGreaterThanOrEqual(0)
        expect(box!.x + box!.width).toBeLessThanOrEqual(size.width + 0.5)
      }
    })

    test('the seeded draft is a row that opens the draft in the viewer', async ({ page }) => {
      await pair(page)
      let draftJob: string | undefined
      for (const job of (await teamRoom(page)).jobs) {
        const body = (await (await page.request.get(`/api/jobs/${job.id}/results`)).json()) as {
          items: { kind: string; title?: string }[]
        }
        if (
          body.items.some((item) => item.kind === 'draft' && item.title === 'Announcement image.md')
        )
          draftJob = job.id
      }
      expect(draftJob, 'a seeded job has the draft').toBeDefined()
      const { files } = await openResults(page, size, `/b?job=${encodeURIComponent(draftJob!)}`)
      await allRows(files)
      const draft = files
        .locator('[data-kind="draft"]')
        .filter({ hasText: 'Announcement image.md' })
      await expect(draft).toHaveAttribute('href', /^\/b\?.*work=draft/)
      await expect(draft).not.toContainText('Saved to the Library')
      await draft.click()
      const sheet = page.getByRole('dialog', { name: 'Workbench viewer' })
      await expect(sheet.getByRole('heading', { name: 'Announcement image.md' })).toBeVisible()
      await expect(sheet).toContainText('Attached document')
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
      // The live fake stream replays its seeded jobs into the room read; a hello-only stream keeps the empty room empty.
      const hello = `event: stream.hello\ndata: ${JSON.stringify(visualHello)}\n\n`
      await page.route('**/api/stream**', (route) =>
        route.fulfill({ contentType: 'text/event-stream', body: hello }),
      )
      const { files } = await openResults(page, size)
      await expect(files.getByText('Nothing made in this job yet')).toBeVisible()
      await expect(files.getByRole('link')).toHaveCount(0)
    })

    test('a failed results request shows Retry and loads after it', async ({ page }) => {
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
      const { files } = await openResults(page, size, `/b?job=${encodeURIComponent(job.id)}`)
      const alert = files.getByRole('alert')
      await expect(alert).toContainText('Couldn’t load the files and results')
      await alert.getByRole('button', { name: 'Retry' }).click()
      await expect(files.locator('[data-files-row]').first()).toBeVisible()
      await expect(files.getByRole('alert')).toHaveCount(0)
    })

    test('a new watch frame refreshes the files and results', async ({ page }) => {
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
      const { files } = await openResults(page, size, `/b?job=${encodeURIComponent(job.id)}`)
      await allRows(files)
      await expect(
        files.locator('[data-kind="link"]').filter({ hasText: 'Activity feed' }),
      ).toBeVisible()
      const before = resultsCalls
      refreshed = true
      // Stream events are envelopes { seq, ts, type, data }, as the hub sends them.
      const envelope = { seq: 48, ts: frame.at, type: 'watch.frame', data: frame }
      stream = `${hello}event: watch.frame\nid: 48\ndata: ${JSON.stringify(envelope)}\n\n`
      await expect(
        files.locator('[data-kind="link"]').filter({ hasText: 'Activity feed after refresh' }),
      ).toBeVisible({ timeout: 20_000 })
      expect(resultsCalls).toBeGreaterThan(before)
    })

    test('Info keeps working beside the files, and the old Results tab and switch are gone', async ({
      page,
    }) => {
      await pair(page)
      const { panel, files } = await openResults(page, size)
      await expect(files.locator('[data-files-row]').first()).toBeVisible()
      await expect(panel.getByRole('heading', { name: 'Members' })).toBeVisible()
      await expect(page.getByTestId('bold-library')).toHaveCount(0)
      await expect(page.getByTestId('bold-results')).toHaveCount(0)
    })

    test('a row opens the viewer sheet on the carried topic, with a visible focus target, and Escape returns to the row', async ({
      page,
    }) => {
      await pair(page)
      const job = await activityFeedJob(page)
      const { files } = await openResults(page, size, `/b?job=${encodeURIComponent(job.id)}`)
      const row = files.locator('[data-files-row="code:api/events.py"]')
      // A key press (not only .focus()) puts the page in keyboard modality, as after a pointer tap on a phone.
      await row.focus()
      await page.keyboard.press('Shift+Tab')
      await page.keyboard.press('Tab')
      await expect(row).toBeFocused()
      expect(await row.evaluate((element) => element.matches(':focus-visible'))).toBe(true)
      if (size.width < 861) {
        const box = await row.boundingBox()
        expect(box).not.toBeNull()
        expect(box!.height).toBeGreaterThanOrEqual(44)
      }

      await row.click()
      await expect
        .poll(() => {
          const url = new URL(page.url())
          return [url.pathname, url.searchParams.get('job'), url.searchParams.get('work')]
        })
        .toEqual(['/b', job.id, 'code'])
      const sheet = page.getByRole('dialog', { name: 'Workbench viewer' })
      await expect(sheet.getByRole('heading', { name: 'Activity feed', level: 2 })).toBeVisible({
        timeout: 20_000,
      })

      await page.keyboard.press('Escape')
      await expect(sheet).toHaveCount(0)
      await expect(row).toBeFocused()
      await expect.poll(() => new URL(page.url()).searchParams.get('work')).toBeNull()
    })
  })
}
