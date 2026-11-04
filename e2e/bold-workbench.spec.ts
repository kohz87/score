import { expect, test, type Page } from '@playwright/test'
import { pair } from './pair.ts'

/** The step list shows the five newest; older steps sit behind "Full history" (the shared server may hold more). */
async function fullHistory(page: Page) {
  const steps = page.getByRole('region', { name: 'What builder did' })
  // Wait for the list itself, then open the history only when there is more than the newest few.
  await steps.getByRole('listitem').first().waitFor()
  const more = steps.getByRole('button', { name: 'Full history' })
  if (await more.count()) await more.click()
}
import { visualHello } from './visual-fixtures.ts'

// PLAN 11.6b: the Workbench and the agent's screen (boards 02 and 12) on the seeded fake team room. The demo moves on
// over time, so the assertions use the seeded job's stable content and ask the API for the note's line numbers.

test.use({ reducedMotion: 'reduce' })

const sizes = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'phone', width: 390, height: 844 },
] as const

type Size = (typeof sizes)[number]
type Job = { id: string; title: string }
type WorkbenchComment = {
  id: string
  text: string
  kind: 'review' | 'approve' | 'send_back'
  line: number | null
  originalLine: number
  outdated: boolean
}
type WorkbenchFile = { path: string; comments: WorkbenchComment[]; cursors: { agentId: string }[] }
type WorkbenchData = { files: WorkbenchFile[] }

async function teamRoom(page: Page): Promise<{ jobs: Job[] }> {
  await expect
    .poll(async () => (await page.request.get('/api/team-room')).status(), { timeout: 30_000 })
    .toBe(200)
  return (await (await page.request.get('/api/team-room')).json()) as { jobs: Job[] }
}

async function activityFeedJob(page: Page): Promise<Job> {
  const job = (await teamRoom(page)).jobs.find((item) => item.title === 'Activity feed')
  expect(job, 'the fake team room seeds the Activity feed job').toBeDefined()
  return job!
}

async function jobWithDraft(page: Page, title: string): Promise<Job> {
  for (const job of (await teamRoom(page)).jobs) {
    const response = await page.request.get(`/api/jobs/${job.id}/results`)
    const body = (await response.json()) as { items: { kind: string; title?: string }[] }
    if (body.items.some((item) => item.kind === 'draft' && item.title === title)) return job
  }
  throw new Error(`No seeded job has the draft ${title}`)
}

async function workbenchData(page: Page, job: Job): Promise<WorkbenchData> {
  const response = await page.request.get(`/api/jobs/${encodeURIComponent(job.id)}/workbench`)
  expect(response.status()).toBe(200)
  return (await response.json()) as WorkbenchData
}

async function openPanel(page: Page, size: Size, path: string) {
  await page.setViewportSize({ width: size.width, height: size.height })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  // 3.25.0: a `?work=` Workbench address opens the viewer sheet (dialog "Workbench viewer") over the conversation, on a
  // phone too (full screen); the old side-panel Work tab is gone.
  await page.goto(path)
  await expect(page.locator('[data-ui="bold"]')).toBeVisible()
  const sheet = page.getByRole('dialog', { name: 'Workbench viewer' })
  await expect(sheet).toBeVisible()
  return sheet
}

for (const size of sizes) {
  test.describe(size.name, () => {
    test('the Workbench shows builder’s lines, both notes, the cursor and a read-only screen', async ({
      page,
    }, testInfo) => {
      await pair(page)
      const job = await activityFeedJob(page)
      const data = await workbenchData(page, job)
      const file = data.files.find((item) => item.path === 'api/events.py')
      expect(file, 'the Activity feed job changed api/events.py').toBeDefined()
      const sendBack = file!.comments.find((comment) => comment.kind === 'send_back')
      const approved = file!.comments.find((comment) => comment.kind === 'approve')
      expect(sendBack, 'reviewer sent the work back').toBeDefined()
      expect(approved, 'reviewer approved the fix').toBeDefined()
      expect(sendBack!.outdated, 'the fix made the send-back note outdated').toBe(true)

      const panel = await openPanel(
        page,
        size,
        `/b?job=${encodeURIComponent(job.id)}&work=workbench`,
      )
      const bench = panel.getByTestId('bold-workbench')
      await expect(bench.getByRole('heading', { name: 'Activity feed' })).toBeVisible()
      const code = bench.getByRole('region', { name: 'Code in api/events.py' })
      await expect(code).toBeVisible()
      await expect(code.getByText('Read-only', { exact: true })).toBeVisible()

      const builderLines = code.locator('[data-by="builder"]')
      expect(await builderLines.count()).toBeGreaterThan(0)
      await expect(builderLines.first().locator('.bold-bench-bar')).toHaveCSS(
        'background-color',
        'rgb(25, 195, 154)',
      )
      await expect(builderLines.first()).toHaveAttribute('title', 'Written by builder')

      const sendBackNote = code.locator('[data-comment="send_back"]')
      await expect(sendBackNote).toContainText(sendBack!.text)
      await expect(sendBackNote).toContainText(`Outdated · was line ${sendBack!.originalLine}`)
      await expect(sendBackNote).toHaveAttribute('data-outdated', 'true')

      const approvedNote = code.locator('[data-comment="approve"]')
      await expect(approvedNote).toContainText(approved!.text)
      await expect(approvedNote).toContainText('Approved')
      if (approved!.line !== null)
        await expect(
          code.locator(
            `[data-line="${approved!.line}"] + .bold-bench-comment-row [data-comment="approve"]`,
          ),
        ).toBeVisible()

      await expect(code.locator('[data-cursor="builder"]')).toBeVisible()
      await expect(bench.locator('input, textarea, [contenteditable="true"]')).toHaveCount(0)
      await page.screenshot({
        path: testInfo.outputPath(`workbench-code-${size.name}.png`),
        fullPage: false,
      })

      const tabs = bench.getByRole('group', { name: 'Workbench files and screens' })
      await tabs.getByRole('button', { name: /builder.s screen/ }).click()
      await expect.poll(() => new URL(page.url()).searchParams.get('work')).toBe('screen')
      const stage = bench.getByRole('region', { name: /builder.s screen/ })
      await expect(stage).toBeVisible()
      await expect(stage.getByText('Read-only · you’re watching')).toBeVisible()
      await expect(stage).toContainText('pnpm test api/events')
      await expect(stage.locator('input, textarea, [contenteditable="true"]')).toHaveCount(0)
      await page.screenshot({
        path: testInfo.outputPath(`workbench-screen-${size.name}.png`),
        fullPage: false,
      })
    })

    test('every Files and results row opens its matching Workbench tab in the viewer sheet', async ({
      page,
    }) => {
      await pair(page)
      await page.setViewportSize({ width: size.width, height: size.height })
      await page.emulateMedia({ reducedMotion: 'reduce' })
      const phone = size.width < 861
      const openInfo = async (path: string) => {
        await page.goto(path)
        await expect(page.locator('[data-ui="bold"]')).toBeVisible()
        if (phone) await page.getByRole('button', { name: 'Chat info' }).click()
        const panel = page.getByRole('complementary', { name: 'Side panel' })
        await expect(panel).toBeVisible()
        const files = panel.getByTestId('files-results')
        await expect(files).toBeVisible()
        return files
      }
      const job = await activityFeedJob(page)
      const files = await openInfo(`/b?job=${encodeURIComponent(job.id)}`)

      const codeRow = files.locator('[data-files-row="code:api/events.py"]')
      await expect(codeRow).toHaveAttribute('href', /^\/b\?.*work=code/)
      await codeRow.click()
      await expect.poll(() => new URL(page.url()).searchParams.get('work')).toBe('code')
      const sheet = page.getByRole('dialog', { name: 'Workbench viewer' })
      await expect(sheet).toBeVisible()
      await expect(
        sheet.getByTestId('bold-workbench').getByRole('region', { name: 'Code in api/events.py' }),
      ).toBeVisible()

      await page.keyboard.press('Escape')
      await expect(sheet).toHaveCount(0)
      // Escape closed only the viewer: Info (a phone's sheet too) is still under it.
      await expect(files).toBeVisible()
      const screenRow = files.locator('[data-files-row^="screen:"]').first()
      await expect(screenRow).toHaveAttribute('href', /work=screen/)
      await screenRow.click()
      await expect.poll(() => new URL(page.url()).searchParams.get('work')).toBe('screen')
      await expect(
        sheet.getByTestId('bold-workbench').getByRole('region', { name: /builder.s screen/ }),
      ).toBeVisible()

      // Files and results follow the selected job: the draft belongs to another seeded job, so open that one.
      const draftJob = await jobWithDraft(page, 'Announcement image.md')
      const draftFiles = await openInfo(`/b?job=${encodeURIComponent(draftJob.id)}`)
      const draftRow = draftFiles.getByRole('link', { name: /Announcement image\.md/ })
      await expect(draftRow).toHaveAttribute('href', /work=draft/)
      await draftRow.click()
      await expect.poll(() => new URL(page.url()).searchParams.get('work')).toBe('draft')
      const workbench = sheet.getByTestId('bold-workbench')
      await expect(workbench.getByRole('heading', { name: 'Announcement image.md' })).toBeVisible()
      await expect(workbench.getByText('Attached document')).toBeVisible()
    })

    test('the agent’s screen shows the step log and the protected approval bar', async ({
      page,
    }, testInfo) => {
      await pair(page)
      await page.setViewportSize({ width: size.width, height: size.height })
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await page.goto('/b/screen/builder')
      await expect(page.getByRole('heading', { name: 'builder’s screen' })).toBeVisible()

      const log = page.getByRole('region', { name: 'What builder did' })
      await fullHistory(page)
      await expect(log.getByRole('button', { name: /Ran pnpm test api\/events/ })).toBeVisible()
      await expect(log.getByRole('button', { name: /Opened the activity feed/ })).toBeVisible()
      await expect(
        log.getByRole('button', { name: /Stopped and asked you: May I install a package/ }),
      ).toBeVisible()

      const bar = page.getByRole('group', { name: 'Approval needed' })
      await expect(bar).toBeVisible()
      await expect(bar).toHaveAttribute('data-protected', 'flex')
      await expect(bar).toContainText('npm install ws@8')
      await expect(bar.getByRole('button', { name: 'Approve' })).toBeVisible()
      await expect(bar.getByRole('button', { name: 'Deny' })).toBeVisible()
      await expect(page.getByRole('link', { name: 'Open in terminal' })).toHaveAttribute(
        'href',
        '/terminal',
      )
      await page.screenshot({
        path: testInfo.outputPath(`agent-screen-${size.name}.png`),
        fullPage: false,
      })
    })

    test('a replay hands an open approval back to live through the protected chip', async ({
      page,
    }) => {
      await pair(page)
      await page.setViewportSize({ width: size.width, height: size.height })
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await page.goto('/b/screen/builder')
      await expect(page.getByRole('heading', { name: 'builder’s screen' })).toBeVisible()

      const bar = page.getByRole('group', { name: 'Approval needed' })
      await expect(bar).toBeVisible()
      await fullHistory(page)
      await page
        .getByRole('region', { name: 'What builder did' })
        .getByRole('button', { name: /Opened the activity feed/ })
        .click()

      const chip = page.getByRole('button', { name: 'Needs you — go live' })
      await expect(chip).toBeVisible()
      await expect(chip).toHaveAttribute('data-protected', 'inline-flex')
      await expect(bar).toHaveCount(0)

      await chip.click()
      await expect(bar).toBeVisible()
      await expect(chip).toHaveCount(0)
    })

    test('deleting the open Workbench job returns to the room with a note', async ({ page }) => {
      await pair(page)
      const job = await activityFeedJob(page)
      const hello = `event: stream.hello\ndata: ${JSON.stringify(visualHello)}\n\n`
      const deleted = {
        seq: 48,
        ts: '2026-10-24T10:00:00.000Z',
        type: 'job.deleted',
        data: { id: job.id, roomId: 'team-room' },
      }
      await page.route('**/api/stream**', (route) =>
        route.fulfill({
          contentType: 'text/event-stream',
          body: `${hello}event: job.deleted\nid: 48\ndata: ${JSON.stringify(deleted)}\n\n`,
        }),
      )
      await openPanel(page, size, `/b?job=${encodeURIComponent(job.id)}&work=workbench`)
      await expect(page).toHaveURL(/\/b$/)
      await expect(
        page.getByRole('status').filter({ hasText: 'That job was deleted.' }),
      ).toBeVisible()
    })
  })
}
