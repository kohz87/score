import { expect, test, type Page } from '@playwright/test'
import { pair } from './pair.ts'

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
  await page.goto(path)
  await expect(page.locator('[data-ui="bold"]')).toBeVisible()
  if (size.width < 861) await page.getByRole('button', { name: 'Open side panel' }).click()
  const panel = page.getByRole('complementary', { name: 'Side panel' })
  await expect(panel).toBeVisible()
  return panel
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

    test('every Results card link opens its matching Workbench tab', async ({ page }) => {
      await pair(page)
      const job = await activityFeedJob(page)
      const panel = await openPanel(page, size, `/b?job=${encodeURIComponent(job.id)}`)
      await expect(panel.getByTestId('bold-results')).toBeVisible()

      const change = panel.locator('[data-card="change"]').filter({ hasText: 'Activity feed' })
      const codeLink = change.getByRole('link', { name: 'See the code · 2 files' })
      await expect(codeLink).toHaveAttribute('href', /^\/b\?job=.+&work=code$/)
      await codeLink.click()
      await expect.poll(() => new URL(page.url()).searchParams.get('work')).toBe('code')
      await expect(
        panel.getByTestId('bold-workbench').getByRole('region', { name: 'Code in api/events.py' }),
      ).toBeVisible()

      await panel
        .getByRole('navigation', { name: 'How to see the work' })
        .getByRole('link', { name: 'Results' })
        .click()
      const preview = panel.locator('[data-card="preview"]')
      const screenLink = preview.getByRole('link', { name: 'Open Activity feed in the Workbench' })
      await expect(screenLink).toHaveAttribute('href', /^\/b\?job=.+&work=screen$/)
      await screenLink.click()
      await expect.poll(() => new URL(page.url()).searchParams.get('work')).toBe('screen')
      await expect(
        panel.getByTestId('bold-workbench').getByRole('region', { name: /builder.s screen/ }),
      ).toBeVisible()

      // Results follow the selected job (11.5): the draft belongs to another seeded job, so open that one.
      const draftJob = await jobWithDraft(page, 'Announcement image.md')
      const draftPanel = await openPanel(page, size, `/b?job=${encodeURIComponent(draftJob.id)}`)
      const draft = draftPanel
        .locator('[data-card="draft"]')
        .filter({ hasText: 'Announcement image.md' })
      const draftLink = draft.getByRole('link', { name: 'Open the draft' })
      await expect(draftLink).toHaveAttribute('href', /^\/b\?job=.+&work=draft$/)
      await draftLink.click()
      await expect.poll(() => new URL(page.url()).searchParams.get('work')).toBe('draft')
      const workbench = panel.getByTestId('bold-workbench')
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
  })
}
