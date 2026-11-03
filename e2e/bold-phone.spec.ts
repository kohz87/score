import { expect, test, type Page } from '@playwright/test'
import { openBoldJob, openBoldRoom } from './bold-room-fixtures.ts'
import { openMenuRoom } from './bold-room-menu-fixtures.ts'
import { holdLockPerTest } from './locks.ts'
import { pair } from './pair.ts'

// PLAN 11.10a: the bold shell as a phone. The room list and full-screen chat use contract-shaped room fixtures so jobs,
// unread counts and state lines do not move under the test; pairing, navigation, the shell and its sheets stay real.
test.use({ reducedMotion: 'reduce' })
holdLockPerTest('roster')

const sizes = [
  { name: '390×844', width: 390, height: 844 },
  { name: '360×740', width: 360, height: 740 },
] as const

const tabs = (page: Page) => page.getByRole('navigation', { name: 'Main' })

async function expectTabBar(page: Page, current: 'Chats' | 'Agents' | 'Settings') {
  const bar = tabs(page)
  await expect(bar).toBeVisible()
  for (const label of ['Chats', 'Agents', 'Knowledge', 'Search', 'Settings'])
    await expect(bar.getByRole('button', { name: label })).toBeVisible()
  await expect(bar.getByRole('button', { name: current })).toHaveAttribute('aria-current', 'page')
}

async function expectAtLeast44(locator: ReturnType<Page['locator']>) {
  // Poll: a control can render a frame before its final layout (labels, fonts) settles.
  await expect(locator).toBeVisible()
  await expect
    .poll(
      async () => {
        const box = await locator.boundingBox()
        return box ? Math.min(box.width, box.height) : 0
      },
      { message: `${await locator.first().getAttribute('aria-label')} is at least 44px` },
    )
    .toBeGreaterThanOrEqual(44)
}

async function expectAboveTabBar(page: Page, locator: ReturnType<Page['locator']>) {
  // Tall pages scroll under the fixed bar by design; what counts is that the end of the content clears it. Poll, since
  // content that loads late grows the page after the first scroll.
  await expect
    .poll(async () => {
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
      const bar = await tabs(page).boundingBox()
      const content = await locator.boundingBox()
      if (!bar || !content) return Number.POSITIVE_INFINITY
      return content.y + content.height - bar.y
    })
    .toBeLessThanOrEqual(1)
}

for (const size of sizes) {
  test.describe(`phone at ${size.name}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: size.width, height: size.height })
    })

    test('opens on the job list, opens a job full screen, writes to it and goes back', async ({
      page,
    }, testInfo) => {
      const state = await openBoldRoom(page)
      await expectTabBar(page, 'Chats')
      // 3.21.0: a chat opens in its conversation; the job list is one step away (`?jobs=1`, from the Info sheet).
      await page.goto('/b?jobs=1')

      const jobs = page.getByRole('region', { name: 'Jobs' })
      await expect(jobs.getByRole('heading', { name: 'Jobs' })).toBeVisible()
      const teamRow = jobs.getByRole('button', { name: /^Team room\./ })
      await expect(teamRow).toBeVisible()
      const done = jobs.getByRole('button', { name: /^Queue research\./ })
      await expect(done.getByRole('img', { name: 'Done' })).toBeVisible()
      const pinned = page.getByRole('article', { name: /Needs you: May I install a package/ })
      await expect(pinned).toHaveAttribute('data-protected', 'flex')
      // The pinned decision comes before the job list in document order.
      expect(
        await pinned.evaluate(
          (el, jobsEl) =>
            Boolean(el.compareDocumentPosition(jobsEl) & Node.DOCUMENT_POSITION_FOLLOWING),
          await jobs.elementHandle(),
        ),
      ).toBe(true)
      await expect(pinned.getByRole('button', { name: 'Allow', exact: true })).toBeVisible()
      await expect(pinned.getByRole('button', { name: 'Don’t allow' })).toBeVisible()
      // The first card is the decision: at 360×740 its actions must fit without scrolling inside the strip.
      const pinBox = await pinned.boundingBox()
      const stripBox = await page.locator('.bold-pins').boundingBox()
      expect(pinBox!.y + pinBox!.height).toBeLessThanOrEqual(stripBox!.y + stripBox!.height + 1)
      expect(
        await page
          .locator('.bold-pins')
          .evaluate((strip) => strip.scrollHeight <= strip.clientHeight),
      ).toBe(true)
      await expectAboveTabBar(page, page.locator('.bold-room-composer'))
      await expectAtLeast44(jobs.getByRole('button', { name: /^Activity feed\./ }))
      // The job list (`?jobs=1`) keeps the room title row, with its own side-panel button.
      await expectAtLeast44(page.getByRole('button', { name: 'Open side panel' }))
      await page.screenshot({ path: testInfo.outputPath(`bold-phone-jobs-${size.width}.png`) })

      await openBoldJob(page, /^Activity feed\./)
      await expect(page).toHaveURL(/job=job-activity/)
      await expect(page.getByRole('button', { name: 'Back to chats' })).toBeVisible()
      await expect(page.locator('.bold-chat-phone-id')).toContainText('Activity feed')
      await expect(page.locator('.bold-chat-phone-id')).toContainText('working')
      await expect(page.getByRole('region', { name: 'Jobs' })).toHaveCount(0)
      await expectAboveTabBar(page, page.locator('.bold-room-composer'))
      await expectAtLeast44(page.getByRole('button', { name: 'Open thread for Activity feed' }))
      for (const label of ['Job menu', 'Show deleted messages'])
        await expectAtLeast44(page.getByRole('button', { name: label }))
      await expectAtLeast44(page.getByRole('button', { name: 'Chat info' }))

      const composer = page.getByRole('combobox', { name: /^Message Team room/ })
      await expectAtLeast44(composer)
      await composer.fill('Check the activity feed on a phone.')
      await page.getByRole('button', { name: 'Send', exact: true }).click()
      await expect(composer).toHaveValue('')
      expect(
        state.requests.find(
          (request) =>
            request.method === 'POST' && request.path === '/api/rooms/team-room/messages',
        )?.body,
      ).toMatchObject({ jobId: 'job-activity', text: 'Check the activity feed on a phone.' })
      await page.screenshot({ path: testInfo.outputPath(`bold-phone-chat-${size.width}.png`) })

      await page.goBack()
      await expect(page).toHaveURL(/jobs=1/)
      await expect(page.getByRole('region', { name: 'Jobs' })).toBeVisible()
      await expect(page.getByRole('button', { name: /^Activity feed\./ })).toBeFocused()
    })

    test('browser Back closes the job chat and returns to the list, not out of /b', async ({
      page,
    }) => {
      await openBoldRoom(page)
      await page.goto('/b?jobs=1')
      await openBoldJob(page, /^Activity feed\./)
      await expect(page).toHaveURL(/job=job-activity/)
      await expect(page.locator('[data-phone-chat-title]')).toBeFocused()

      await page.goBack()
      await expect(page).toHaveURL(/jobs=1/)
      await expect(page.getByRole('heading', { name: 'Jobs' })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Back to chats' })).toHaveCount(0)
      await expect(page.getByRole('button', { name: /^Activity feed\./ })).toBeFocused()
    })

    test('the Team room row opens the default job, the home of a list message', async ({
      page,
    }) => {
      const state = await openBoldRoom(page)
      await page.goto('/b?jobs=1')
      const teamRow = page.getByRole('button', { name: /^Team room\..*/ })
      await expect(teamRow).toBeVisible()
      await expect(teamRow).toContainText('lead is working')

      const composer = page.getByRole('combobox', { name: /^Message Team room/ })
      await composer.fill('A note to the team.')
      await page.getByRole('button', { name: 'Send', exact: true }).click()
      await expect(composer).toHaveValue('')
      const sent = state.requests.find(
        (request) => request.method === 'POST' && request.path === '/api/rooms/team-room/messages',
      )?.body as Record<string, unknown> | undefined
      expect(sent).toEqual(expect.objectContaining({ text: 'A note to the team.' }))
      // From the list the composer sends with no jobId, so the server files it in the default job (as All does on
      // desktop): any other job here would be a regression.
      expect(sent && 'jobId' in sent ? sent['jobId'] : undefined).toBeUndefined()

      await teamRow.click()
      await expect(page).toHaveURL(/job=job-default/)
      await expect(page.locator('[data-phone-chat-title]')).toHaveText('Team room')
      await expect(page.getByText('Event cursors are (created_at, id).')).toBeVisible()
      await expect(page.getByRole('button', { name: 'Back to chats' })).toBeVisible()
    })

    test('answers the pinned approval in place and reports the POST', async ({ page }) => {
      const state = await openBoldRoom(page)
      const card = page.getByRole('article', { name: /Needs you: May I install a package/ })
      await expect(card).toContainText('npm install ws@8')
      await expectAtLeast44(card.getByRole('button', { name: 'Allow', exact: true }))
      await expectAtLeast44(card.getByRole('button', { name: 'Don’t allow' }))

      await card.getByRole('button', { name: 'Allow', exact: true }).click()
      await expect(card.getByRole('status')).toContainText('Approved by you')
      expect(
        state.requests.find(
          (request) =>
            request.method === 'POST' &&
            request.path === '/api/approvals/approval-package/decision',
        )?.body,
      ).toEqual({ choice: 'once' })
    })

    test('opens the side-panel modes as a sheet, closes it with Escape and returns focus', async ({
      page,
    }, testInfo) => {
      await openBoldRoom(page)
      const opener = page.getByRole('button', { name: 'Chat info' }).first()
      await expectAtLeast44(opener)
      await opener.click()

      const panel = page.getByRole('complementary', { name: 'Side panel' })
      await expect(panel).toBeVisible()
      await expect(panel).toHaveAttribute('aria-modal', 'true')
      await expect(tabs(page)).toHaveAttribute('inert', '')
      await expect(page.getByRole('button', { name: 'Close side panel' })).toBeFocused()
      await page.screenshot({ path: testInfo.outputPath(`bold-phone-sheet-${size.width}.png`) })

      await page.keyboard.press('Escape')
      await expect(panel).toBeHidden()
      await expect(opener).toBeFocused()

      await opener.click()
      await page.getByRole('button', { name: 'Close side panel' }).click()
      await expect(panel).toBeHidden()
      await expect(opener).toBeFocused()
    })

    test('one Escape closes the side-panel menu, the next closes the sheet', async ({ page }) => {
      await openBoldRoom(page)
      const opener = page.getByRole('button', { name: 'Chat info' }).first()
      await opener.click()
      const panel = page.getByRole('complementary', { name: 'Side panel' })
      await expect(panel).toBeVisible()

      const toggle = panel.getByRole('button', { name: /^Info/ })
      await toggle.click()
      const menu = panel.locator('.side-menu')
      await expect(menu).toBeVisible()

      await page.keyboard.press('Escape')
      await expect(menu).toHaveCount(0)
      await expect(panel).toBeVisible()
      await expect(toggle).toBeFocused()

      await page.keyboard.press('Escape')
      await expect(panel).toBeHidden()
      await expect(opener).toBeFocused()
    })

    test('Room, Agents and Settings each keep the tab bar and content above it', async ({
      page,
    }, testInfo) => {
      await openBoldRoom(page)
      await expectTabBar(page, 'Chats')

      await tabs(page).getByRole('button', { name: 'Agents' }).click()
      await expect(page).toHaveURL('/b/agents')
      await expect(page.getByRole('heading', { name: 'Agents', level: 1 })).toBeVisible()
      await expectTabBar(page, 'Agents')
      await expectAtLeast44(page.getByRole('button', { name: 'Add' }))
      const builder = page
        .locator('.bold-agentcard')
        .filter({ has: page.getByRole('link', { name: 'builder', exact: true }) })
      await expect(builder.getByRole('link', { name: 'Message', exact: true })).toHaveAttribute(
        'href',
        '/b?with=builder',
      )
      await expectAtLeast44(builder.getByRole('link', { name: 'Message', exact: true }))
      await expectAboveTabBar(page, builder)
      await page.screenshot({ path: testInfo.outputPath(`bold-phone-team-${size.width}.png`) })

      await tabs(page).getByRole('button', { name: 'Settings' }).click()
      await expect(page).toHaveURL('/b/settings')
      await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible()
      await expectTabBar(page, 'Settings')
      await expectAboveTabBar(page, page.locator('.setmain'))
      await page.screenshot({ path: testInfo.outputPath(`bold-phone-settings-${size.width}.png`) })

      await tabs(page).getByRole('button', { name: 'Chats' }).click()
      await expect(page).toHaveURL(/\/b(\?open=1)?$/)
      await expectTabBar(page, 'Chats')
      const chats = page.getByRole('complementary', { name: 'Chats', exact: true })
      await expect(chats).toBeVisible()
      // Opening the team chat from the list lands in its conversation: its stream and composer, and a way back.
      await chats.getByRole('link', { name: /^Team room/ }).click()
      await expect(page.getByRole('region', { name: 'Team room' })).toBeVisible()
      await expect(page.getByRole('combobox', { name: /^Message Team room/ })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Back to chats' })).toBeVisible()
    })

    test('the Room tab keeps the Needs-you count while Agents is open', async ({ page }) => {
      await openBoldRoom(page)
      const nav = tabs(page)
      const room = nav.getByRole('button', { name: /^Chats, \d+ need you$/ })
      await expect(room).toHaveAccessibleName('Chats, 2 need you')
      const badge = room.locator('.bold-tab-count')
      await expect(badge).toHaveText('2')
      await expect(badge).toHaveAttribute('data-protected', 'inline-flex')
      expect(await badge.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe(
        'rgba(0, 0, 0, 0)',
      )

      await nav.getByRole('button', { name: 'Agents' }).click()
      await expect(page).toHaveURL('/b/agents')
      await expectTabBar(page, 'Agents')
      await expect(room).toHaveAccessibleName('Chats, 2 need you')
      await expect(badge).toHaveText('2')
    })

    test('older and imported rooms use the phone chat without overflow', async ({
      page,
    }, testInfo) => {
      await openMenuRoom(page)
      // 3.21.0: older and imported rooms are not in the chat list; a phone reaches them from the picker on the job list.
      await page.goto('/b?jobs=1')
      const picker = page.getByRole('button', { name: 'Team room', exact: true })
      await picker.click()
      await page.getByRole('option', { name: /#activity-feed/ }).click()

      await expect(page).toHaveURL(/room=room-old/)
      await expect(page.getByRole('button', { name: 'Back to chats' })).toBeVisible()
      await expect(page.locator('[data-phone-chat-title]')).toHaveText('#activity-feed')
      await expect(
        page.getByText('The feed is live. Ask builder for the cursor work.'),
      ).toBeVisible()
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      )
      expect(overflow).toBeLessThanOrEqual(0)
      await expectAtLeast44(page.getByRole('button', { name: 'Back to chats' }))
      await expectAtLeast44(page.getByRole('button', { name: 'Room menu' }))
      await page.screenshot({ path: testInfo.outputPath(`bold-phone-older-${size.width}.png`) })

      await page.getByRole('button', { name: 'Back to chats' }).click()
      await expect(page).toHaveURL(/\/b(\?open=1)?$/)
      await expect(page.getByRole('complementary', { name: 'Chats', exact: true })).toBeVisible()

      await page.goto('/b?jobs=1')
      await page.getByRole('button', { name: 'Team room', exact: true }).click()
      await page.getByRole('option', { name: /#telegram-plan #imported/ }).click()
      await expect(page).toHaveURL(/room=room-imported/)
      await expect(page.getByRole('button', { name: 'Back to chats' })).toBeVisible()
      await expect(page.locator('[data-phone-chat-title]')).toHaveText('#telegram-plan #imported')
      await expect(page.getByText('Outline the launch checklist.')).toBeVisible()
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
      ).toBeLessThanOrEqual(0)
      await page.screenshot({
        path: testInfo.outputPath(`bold-phone-imported-${size.width}.png`),
      })
    })
  })
}

for (const size of sizes) {
  test(`Agents’ Message opens the one-to-one full screen at ${size.name}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: size.width, height: size.height })
    await pair(page)
    await page.goto('/b/agents')
    const builder = page
      .locator('.bold-agentcard')
      .filter({ has: page.getByRole('link', { name: 'builder', exact: true }) })
    await builder.getByRole('link', { name: 'Message', exact: true }).click()
    await expect(page).toHaveURL(/\/b\?with=builder&chat=job_/)
    const panel = page.getByRole('complementary', { name: 'Side panel' })
    await expect(panel).toBeVisible()
    await expect(panel).toHaveAttribute('aria-modal', 'true')
    const privacy = panel.locator('[data-protected].bold-dm-privacy')
    await expect(privacy).toBeVisible()
    await expect(privacy).toHaveText('Only you and builder see this')
    await expect(panel.locator('.bold-dm-thread')).toBeVisible()
    await expectAtLeast44(panel.getByRole('button', { name: 'Earlier chats' }))
    const composer = panel.getByPlaceholder('Message builder privately')
    await expectAtLeast44(composer)
    await expectAtLeast44(panel.locator('button.chat-send'))
    await page.screenshot({ path: testInfo.outputPath(`bold-phone-one-to-one-${size.width}.png`) })

    await page.getByRole('button', { name: 'Back', exact: true }).click()
    // A phone one-to-one is a sheet over the room: Back closes it where it came from.
    await expect(page).toHaveURL(/\/b(\?open=1)?$/)
    await expect(panel).toBeHidden()
    await expect(page.getByRole('complementary', { name: 'Chats', exact: true })).toBeVisible()
    await expectTabBar(page, 'Chats')
  })
}

test('Search opens a one-to-one full screen and Back returns to the job list', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 })
  await openBoldRoom(page)
  await tabs(page).getByRole('button', { name: 'Search' }).click()
  const search = page.getByRole('dialog', { name: 'Search and commands' })
  const query = search.getByRole('combobox', { name: 'Search or run a command' })
  await query.fill('Message reviewer')
  await search.getByRole('option', { name: 'Message reviewer' }).click()
  await expect(search).toBeHidden()
  const panel = page.getByRole('complementary', { name: 'Side panel' })
  await expect(panel).toBeVisible()
  await expect(page).toHaveURL(/with=reviewer/)
  await expect(panel.locator('[data-protected].bold-dm-privacy')).toContainText(
    'Only you and reviewer see this',
  )
  await page.getByRole('button', { name: 'Back', exact: true }).click()
  await expect(page).toHaveURL(/\/b(\?open=1)?$/)
  await expect(panel).toBeHidden()
})
