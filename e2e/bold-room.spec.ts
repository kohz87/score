import { expect, test, type Page } from '@playwright/test'
import { openBoldJob, openBoldRoom } from './bold-room-fixtures.ts'
import { pair } from './pair.ts'

// PLAN 11.4a: the bold team room. The robot room moves over time, so these specs pin the contract-shaped reads to a
// stable fixture while the shell, pairing, request validation and real-page routing stay the app's own.
test.use({
  reducedMotion: 'reduce',
  permissions: ['clipboard-read', 'clipboard-write'],
})

const sizes = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
] as const

test('a second job keeps its unread badge until its own tab is opened (real fake server)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await pair(page)
  await expect
    .poll(async () => (await page.request.get('/api/team-room')).status(), { timeout: 30_000 })
    .toBe(200)
  const team = (await (await page.request.get('/api/team-room')).json()) as {
    jobs: { title: string; unread: number }[]
  }
  const notes = team.jobs.find((job) => job.title === 'Release notes 2.4')
  expect(notes?.unread ?? 0).toBeGreaterThan(0)

  await page.goto('/b')
  const notesTab = page.getByRole('tab', { name: /Release notes 2\.4/ })
  const badge = notesTab.locator('.bold-unread')
  await expect(badge).toHaveText(String(notes!.unread), { timeout: 30_000 })

  await page.getByRole('tab', { name: /Activity feed/ }).click()
  await expectDestination(page, 'To: Activity feed')
  await expect(badge).toHaveText(String(notes!.unread))

  await notesTab.click()
  await expectDestination(page, 'To: Release notes 2.4')
  await expect(notesTab.locator('.bold-unread')).toHaveCount(0)
})

/** The composer's destination pill. On a phone it is hidden by design (the pill composer), so read its text, not its visibility. */
async function expectDestination(page: Page, label: string) {
  await expect(page.locator('.chat-composer-room-to')).toHaveText(label)
}

async function openJob(page: Page, title: RegExp) {
  await openBoldJob(page, title)
}

function message(page: Parameters<typeof openBoldRoom>[0], id: string) {
  return page.locator(`[data-message-id="${id}"]`)
}

function pendingApproval() {
  return {
    id: 'approval-empty-room',
    origin: 'score-run',
    phase: 'human_pending',
    status: 'pending',
    actionable: true,
    linkedTo: null,
    agentId: 'builder',
    title: 'May I install a package?',
    command: 'npm install ws@8',
    cwd: '~/app',
    description: 'The websocket feed needs ws.',
    choices: ['once', 'session', 'always', 'deny'],
    createdAt: '2026-10-24T10:07:00.000Z',
    expiresAt: null,
    decision: null,
    delivery: 'none',
    blocking: null,
    refs: [],
  }
}

for (const viewport of sizes) {
  const at = `${viewport.width}×${viewport.height}`

  test.describe(at, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize(viewport)
    })

    test(`job tabs keep their unread counts and every D10 filter narrows the room at ${at}`, async ({
      page,
    }) => {
      await openBoldRoom(page)

      if (viewport.width <= 860) {
        await expect(page.getByRole('heading', { name: 'Jobs' })).toBeVisible()
        const activity = page.getByRole('button', { name: /^Activity feed\..*2 unread/ })
        const notes = page.getByRole('button', { name: /^Release notes 2\.4\..*3 unread/ })
        const queue = page.getByRole('button', { name: /^Queue research\./ })
        await expect(activity).toBeVisible()
        await expect(notes).toBeVisible()
        await expect(queue).toBeVisible()
        await expect(queue.locator('.bold-unread')).toHaveCount(0)

        await activity.click()
        expect(new URL(page.url()).searchParams.get('job')).toBe('job-activity')
        await expectDestination(page, 'To: Activity feed')
        await expect(
          page.getByText('Read layer is ready. The feed renders newest first.'),
        ).toBeVisible()
        await expect(
          page.getByText('Draft is ready. The migration steps are still open.'),
        ).toHaveCount(0)
        await page.getByRole('button', { name: 'Back to jobs' }).click()
        await expect(page.getByRole('heading', { name: 'Jobs' })).toBeVisible()
        await expect(page.getByRole('button', { name: /^Activity feed\..*/ })).toBeVisible()
        return
      }

      const all = page.getByRole('tab', { name: /^All/ })
      const activity = page.getByRole('tab', { name: /Activity feed/ })
      const notes = page.getByRole('tab', { name: /Release notes 2\.4/ })
      const queue = page.getByRole('tab', { name: /Queue research/ })
      await expect(all).toContainText('5')
      await expect(activity).toContainText('2')
      await expect(notes).toContainText('3')
      await expect(queue.locator('.bold-unread')).toHaveCount(0)

      await activity.click()
      expect(new URL(page.url()).searchParams.get('job')).toBe('job-activity')
      await expectDestination(page, 'To: Activity feed')
      await expect(
        page.getByText('Read layer is ready. The feed renders newest first.'),
      ).toBeVisible()
      await expect(
        page.getByText('Draft is ready. The migration steps are still open.'),
      ).toHaveCount(0)

      await page.getByRole('button', { name: 'Needs you', exact: true }).click()
      await expect(page.getByRole('button', { name: 'Needs you', exact: true })).toHaveAttribute(
        'aria-pressed',
        'true',
      )
      await expect(notes).toBeVisible()
      await expect(activity).toHaveCount(0)
      await expect(queue).toHaveCount(0)

      await page.getByRole('button', { name: 'Working', exact: true }).click()
      await expect(activity).toBeVisible()
      await expect(notes).toHaveCount(0)
      await expect(queue).toHaveCount(0)

      await page.getByRole('button', { name: 'Done', exact: true }).click()
      await expect(queue).toBeVisible()
      await expect(page.getByRole('button', { name: 'Closed jobs', exact: true })).toBeVisible()
      await expect(notes).toHaveCount(0)
      await expect(activity).toHaveCount(0)

      await page.getByRole('button', { name: 'All', exact: true }).click()
      await expect(page.getByRole('tab', { name: /^All/ })).toBeVisible()
      await expect(activity).toBeVisible()
      await expect(notes).toBeVisible()
      await expect(queue).toBeVisible()
    })

    test(`approvals and a paused review are protected request cards at ${at}`, async ({ page }) => {
      // The exchange answer comes back without the exchange leaving its pause, so the sent note stays readable.
      const state = await openBoldRoom(page, {
        handle: (request) =>
          request.method === 'POST' && /^\/api\/exchanges\/[^/]+\/decision$/.test(request.path)
            ? { body: { ok: true } }
            : undefined,
      })

      const approval = page.getByRole('article', { name: /May I install a package/ })
      const review = page.getByRole('article', {
        name: /The review ended without a verdict/,
      })
      await expect(approval).toHaveAttribute('data-protected', 'flex')
      await expect(review).toBeHidden()
      await page.getByRole('button', { name: '1 more needs you' }).click()
      await expect(review).toHaveAttribute('data-protected', 'flex')
      await expect(review).toBeVisible()
      await expect(approval).toContainText('npm install ws@8')
      await expect(review).toContainText('Release notes 2.4')

      await approval.getByRole('button', { name: 'Allow', exact: true }).click()
      await expect(approval.getByRole('status')).toContainText('Approved by you')
      expect(
        state.requests.find(
          (request) =>
            request.method === 'POST' &&
            request.path === '/api/approvals/approval-package/decision',
        )?.body,
      ).toEqual({ choice: 'once' })

      await review.getByRole('button', { name: 'Send back', exact: true }).click()
      await review.getByLabel('Note for the author').fill('Add the 2.3 migration steps.')
      await review.getByRole('button', { name: 'Send back', exact: true }).click()
      await expect(review.getByRole('status')).toContainText('Sent back with your note.')
      expect(
        state.requests.find(
          (request) =>
            request.method === 'POST' && request.path === '/api/exchanges/exchange-notes/decision',
        )?.body,
      ).toEqual({ option: 'send_back', note: 'Add the 2.3 migration steps.' })
    })

    test(`@name sends to that agent in the selected job at ${at}`, async ({ page }) => {
      const state = await openBoldRoom(page)
      await openBoldJob(page, /Release notes 2\.4/)

      const composer = page.getByRole('combobox', { name: /^Message Team room/ })
      await composer.fill('@rev')
      await page
        .getByRole('listbox', { name: 'Agents' })
        .getByRole('option', { name: /@reviewer/ })
        .click()
      await expect(composer).toHaveValue('@reviewer ')
      await composer.pressSequentially('Please check the migration steps.')
      await page.getByRole('button', { name: 'Send', exact: true }).click()

      await expect(composer).toHaveValue('')
      const sent = state.requests.find(
        (request) => request.method === 'POST' && request.path === '/api/rooms/team-room/messages',
      )
      // The @mention travels in the text: the server merges it with any explicit To chips (contract), so no `to` here.
      expect(sent?.body).toMatchObject({
        jobId: 'job-notes',
        text: '@reviewer Please check the migration steps.',
      })
      expect(sent?.body).not.toHaveProperty('to')
    })

    test(`+ attaches a file with visible progress and sends it at ${at}`, async ({ page }) => {
      const state = await openBoldRoom(page, { uploadDelay: 900 })
      await page.getByRole('button', { name: 'Attach, voice and commands' }).click()
      const menu = page.getByRole('list', { name: 'Attach, voice and commands' })
      await expect(menu.getByRole('button', { name: 'Upload files…' })).toBeVisible()
      const chooser = page.waitForEvent('filechooser')
      await menu.getByRole('button', { name: 'Upload files…' }).click()
      await (
        await chooser
      ).setFiles({
        name: 'notes.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('Release notes draft'),
      })

      const progress = page.locator('.upload-progress-compact')
      await expect(progress).toContainText('notes.txt')
      await expect(progress.locator('progress')).toBeVisible()
      const attachments = page.getByRole('list', { name: 'Attachments' })
      await expect(attachments.getByText('notes.txt')).toBeVisible()
      await page.getByRole('combobox', { name: /^Message Team room/ }).fill('Here is the draft.')
      await page.getByRole('button', { name: 'Send', exact: true }).click()

      const sent = state.requests.find(
        (request) => request.method === 'POST' && request.path === '/api/rooms/team-room/messages',
      )
      expect(sent?.body).toMatchObject({
        text: 'Here is the draft.',
        attachments: [{ mediaId: 'media-notes', name: 'notes.txt' }],
      })
      await expect(attachments).toHaveCount(0)
    })

    test(`the slash menu runs an /assign command at ${at}`, async ({ page }) => {
      const state = await openBoldRoom(page)
      const composer = page.getByRole('combobox', { name: /^Message Team room/ })
      await composer.fill('/')
      const commands = page.getByRole('listbox', { name: 'Commands' })
      await expect(commands.getByRole('option', { name: /^\/assign/ })).toBeVisible()
      await composer.press('Enter')
      await expect(composer).toHaveValue('/assign ')

      await composer.pressSequentially('Audit the release notes')
      await page.getByRole('button', { name: 'Send', exact: true }).click()
      const status = page.getByRole('status').filter({ hasText: 'Created task' })
      await expect(status).toContainText('OPS-1')
      expect(
        state.requests.find(
          (request) =>
            request.method === 'POST' && request.path === '/api/rooms/team-room/messages',
        )?.body,
      ).toMatchObject({ text: '/assign Audit the release notes' })
    })

    test(`the hover row copies, saves, and pins or unpins at ${at}`, async ({ page }) => {
      const state = await openBoldRoom(page)
      if (viewport.width <= 860) {
        await openJob(page, /^Team room\./)
        await expect(message(page, 'message-pinned')).toBeVisible()
      }
      const pinned = message(page, 'message-pinned')
      await pinned.hover()
      await expect(
        pinned.getByRole('button', { name: 'Unpin message from reviewer' }),
      ).toBeVisible()
      await pinned.getByRole('button', { name: 'Unpin message from reviewer' }).click()
      await expect(pinned.getByRole('button', { name: 'Pin message from reviewer' })).toBeVisible()
      expect(
        state.requests.some(
          (request) =>
            request.method === 'DELETE' &&
            request.path === '/api/rooms/team-room/pins/message-pinned',
        ),
      ).toBe(true)
      await pinned.getByRole('button', { name: 'Pin message from reviewer' }).click()
      await expect(
        pinned.getByRole('button', { name: 'Unpin message from reviewer' }),
      ).toBeVisible()
      expect(
        state.requests.some(
          (request) =>
            request.method === 'POST' &&
            request.path === '/api/rooms/team-room/pins/message-pinned',
        ),
      ).toBe(true)

      if (viewport.width <= 860) await page.getByRole('button', { name: 'Back to jobs' }).click()
      await openJob(page, /Activity feed/)
      const builder = message(page, 'message-builder')
      await builder.hover()
      await builder.getByRole('button', { name: 'Copy message from builder' }).click()
      await expect(builder.getByRole('button', { name: 'Copy message from builder' })).toHaveText(
        'Copied',
      )
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
        'Read layer is ready. The feed renders newest first.',
      )

      await builder.hover()
      await builder.getByRole('button', { name: 'Save message from builder to Library' }).click()
      const save = page.getByRole('dialog', { name: 'Save to Knowledge' })
      await expect(save.getByText('This reply as a note')).toBeVisible()
      await save.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(save.getByRole('status')).toContainText(/Added inbox\/Reply from builder .*\.md/)
      expect(
        state.requests.some(
          (request) =>
            request.method === 'PUT' &&
            decodeURIComponent(request.path).startsWith(
              '/api/knowledge/files/inbox/Reply from builder',
            ),
        ),
      ).toBe(true)
      await save.getByRole('button', { name: 'Done' }).click()
    })

    test(`edit rewinds then sends the correction at ${at}`, async ({ page }) => {
      const state = await openBoldRoom(page)
      await openJob(page, /Activity feed/)
      const own = message(page, 'message-action')
      await own.hover()
      await own.getByRole('button', { name: 'Edit message from You' }).click()
      const composer = page.getByRole('combobox', { name: /^Message Team room/ })
      await expect(composer).toHaveValue('Please add pagination.')
      await expect(page.getByText(/Sending replaces it and rewinds/)).toBeVisible()
      await composer.fill('Please add pagination, newest first.')
      await page.getByRole('button', { name: 'Send correction', exact: true }).click()

      // 2.0.12: Send rewinds and posts by itself when every agent can be rewound.
      await expect(page.getByRole('dialog', { name: 'Edit and send again?' })).toHaveCount(0)

      await expect
        .poll(() =>
          state.requests.find(
            (request) =>
              request.method === 'POST' && request.path === '/api/rooms/team-room/messages',
          ),
        )
        .toBeTruthy()
      expect(
        state.requests.find(
          (request) =>
            request.method === 'POST' && request.path === '/api/rooms/team-room/messages',
        )?.body,
      ).toMatchObject({ edits: 'message-action', text: 'Please add pagination, newest first.' })
      expect(
        state.requests.some(
          (request) =>
            request.method === 'POST' &&
            request.path === '/api/rooms/team-room/messages/message-action/rewind',
        ),
      ).toBe(true)
    })

    test(`delete opens the rewind dialog and the toggle reveals deleted history at ${at}`, async ({
      page,
    }) => {
      const state = await openBoldRoom(page)
      await openJob(page, /Activity feed/)
      const own = message(page, 'message-activity')
      await own.hover()
      await own.getByRole('button', { name: 'Delete message from You' }).click()
      const dialog = page.getByRole('dialog', { name: 'Delete this message?' })
      await expect(
        dialog.getByText(/2 messages \(this one and everything after it\)/),
      ).toBeVisible()
      await dialog.getByRole('button', { name: 'Rewind and delete' }).click()
      await expect
        .poll(() =>
          state.requests.find(
            (request) =>
              request.method === 'POST' &&
              request.path === '/api/rooms/team-room/messages/message-activity/rewind',
          ),
        )
        .toBeTruthy()

      await expect(page.getByText('Old plan we replaced.')).toHaveCount(0)
      await page.getByRole('button', { name: 'Show deleted messages' }).click()
      const deleted = page.getByRole('region', { name: 'Deleted messages' })
      await expect(deleted).toContainText('Deleted, read-only. 2 hidden messages.')
      await expect(deleted.getByText('Old plan we replaced.')).toBeVisible()
      await page.getByRole('button', { name: 'Hide deleted messages' }).click()
      await expect(deleted).toHaveCount(0)
    })

    test(`versions step from ‹ 3 / 3 › to 2 / 3 and 1 / 3 at ${at}`, async ({ page }) => {
      await openBoldRoom(page)
      await openJob(page, /Activity feed/)
      const edited = message(page, 'message-edit')
      const control = edited.getByRole('group', { name: 'Message versions' })
      await expect(control).toContainText('Version 3 of 3')
      await control.getByRole('button', { name: 'Previous version' }).click()
      await expect(page.getByRole('region', { name: 'Version 2 of 3' })).toBeVisible()
      await expect(page.getByText('Make the cursor stable, second wording.')).toBeVisible()
      await page
        .getByRole('region', { name: 'Version 2 of 3' })
        .getByRole('button', { name: 'Previous version' })
        .click()
      await expect(page.getByRole('region', { name: 'Version 1 of 3' })).toBeVisible()
      await expect(page.getByText('Make the cursor stable, first wording.')).toBeVisible()
      await page.getByRole('button', { name: 'Back to latest' }).click()
      await expect(page.getByRole('region', { name: /^Version [12] of 3$/ })).toHaveCount(0)
    })

    test(`result links open the job and seek to its message at ${at}`, async ({ page }) => {
      await openBoldRoom(page)
      const href = '/b?job=job-queue&message=message-queue'
      const result = page.getByRole('link', { name: 'Open result: Queue research' })
      if (viewport.width <= 860) {
        // The phone's list row is the result: tapping it opens the job. The seek target is the same link as the desktop
        // card's, so it is then followed as a link (Search and notifications open it the same way).
        await page.getByRole('button', { name: /^Queue research\. Done/ }).click()
        await expect(page).toHaveURL(/[?&]job=job-queue/)
        await expect(page.getByRole('button', { name: 'Back to jobs' })).toBeVisible()
        await page.goto(href)
      } else {
        // A finished job starts folded in All; Show opens it in place.
        await page.getByRole('button', { name: 'Show Queue research' }).click()
        await expect(result).toHaveAttribute('href', href)
        await expect(result).toContainText('Done · lead')
        await result.click()
      }
      await expect(page).toHaveURL(/[?&]job=job-queue/)
      if (viewport.width > 860)
        await expect(page.getByRole('tab', { name: /Queue research/ })).toHaveAttribute(
          'aria-selected',
          'true',
        )
      else await expect(page.getByRole('button', { name: 'Back to jobs' })).toBeVisible()
      await expectDestination(page, 'To: Queue research')
      const article = page.locator('#message-message-queue')
      await expect(article).toHaveClass(/bold-message-hit/)
      await expect(article).toBeFocused()
    })

    test(`a fresh team room shows board 09 and its starters fill the composer at ${at}`, async ({
      page,
    }) => {
      await openBoldRoom(page, { empty: true })
      await expect(
        page.getByRole('heading', { name: 'Your team is ready. What first?' }),
      ).toBeVisible()
      await expect(page.getByRole('tablist', { name: 'Jobs' })).toHaveCount(0)
      await expect(page.getByRole('button', { name: /Build something, reviewed/ })).toBeVisible()
      await expect(page.getByRole('button', { name: /Research and compare/ })).toBeVisible()
      await expect(page.getByRole('button', { name: /Write and review a document/ })).toBeVisible()
      await expect(page.getByRole('button', { name: /Design something/ })).toBeVisible()
      const composer = page.getByRole('combobox', { name: /^Message Team room/ })
      await expect(composer).toHaveAttribute('placeholder', 'Describe the work')
      await page.getByRole('button', { name: /Build something, reviewed/ }).click()
      await expect(composer).toHaveValue('Build a small feature and have reviewer check it.')
      await expect(composer).toBeFocused()
    })

    test(`a fresh team room still shows an approval that names no room at ${at}`, async ({
      page,
    }) => {
      await openBoldRoom(page, {
        empty: true,
        handle: (request) =>
          request.method === 'GET' && request.path === '/api/approvals'
            ? {
                body: {
                  asOfSeq: 12,
                  items: [pendingApproval()],
                  nextCursor: null,
                },
              }
            : undefined,
      })
      await expect(
        page.getByRole('heading', { name: 'Your team is ready. What first?' }),
      ).toBeVisible()
      const strip = page.getByRole('region', { name: 'Needs you' })
      await expect(strip).toBeVisible()
      const card = strip.getByRole('article', { name: /May I install a package/ })
      await expect(card).toBeVisible()
      await expect(card).toHaveAttribute('data-protected', 'flex')
      await expect(card.getByRole('button', { name: 'Allow', exact: true })).toBeVisible()
    })
  })
}
