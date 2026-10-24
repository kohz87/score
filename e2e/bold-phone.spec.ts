import { expect, test, type Page } from '@playwright/test'
import { openBoldJob, openBoldRoom } from './bold-room-fixtures.ts'
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

async function expectTabBar(page: Page, current: 'Room' | 'Team' | 'Settings') {
  const bar = tabs(page)
  await expect(bar).toBeVisible()
  for (const label of ['Room', 'Team', 'Search', 'Settings'])
    await expect(bar.getByRole('button', { name: label })).toBeVisible()
  await expect(bar.getByRole('button', { name: current })).toHaveAttribute('aria-current', 'page')
}

async function expectAtLeast44(locator: ReturnType<Page['locator']>) {
  const box = await locator.boundingBox()
  expect(box?.width, `${await locator.getAttribute('aria-label')} width`).toBeGreaterThanOrEqual(44)
  expect(box?.height, `${await locator.getAttribute('aria-label')} height`).toBeGreaterThanOrEqual(
    44,
  )
}

async function expectAboveTabBar(page: Page, locator: ReturnType<Page['locator']>) {
  const bar = await tabs(page).boundingBox()
  const content = await locator.boundingBox()
  expect(content, 'content has a box').not.toBeNull()
  expect(bar, 'tab bar has a box').not.toBeNull()
  expect(content!.y + content!.height).toBeLessThanOrEqual(bar!.y + 1)
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
      await expectTabBar(page, 'Room')

      const jobs = page.getByRole('region', { name: 'Jobs' })
      await expect(jobs.getByRole('heading', { name: 'Jobs' })).toBeVisible()
      await expect(jobs.getByRole('button', { name: /^Team room\./ })).toHaveCount(0)
      const done = jobs.getByRole('button', { name: /^Queue research\./ })
      await expect(done.getByRole('img', { name: 'Done' })).toBeVisible()
      const pinned = page.getByRole('article', { name: /Needs you: May I install a package/ })
      await expect(pinned).toHaveAttribute('data-protected', 'flex')
      expect(pinned.compareDocumentPosition(jobs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      await expect(pinned.getByRole('button', { name: 'Allow' })).toBeVisible()
      await expect(pinned.getByRole('button', { name: 'Don’t allow' })).toBeVisible()
      await expectAboveTabBar(page, page.locator('.bold-room-composer'))
      await expectAtLeast44(jobs.getByRole('button', { name: /^Activity feed\./ }))
      await expectAtLeast44(page.getByRole('button', { name: 'Open side panel' }))
      await page.screenshot({ path: testInfo.outputPath(`bold-phone-jobs-${size.width}.png`) })

      await openBoldJob(page, /^Activity feed\./)
      await expect(page).toHaveURL(/job=job-activity/)
      await expect(page.getByRole('button', { name: 'Back to jobs' })).toBeVisible()
      await expect(page.locator('.bold-phone-chat-id')).toContainText('Activity feed')
      await expect(page.locator('.bold-phone-chat-id')).toContainText('builder is working')
      await expect(page.getByRole('region', { name: 'Jobs' })).toHaveCount(0)
      await expectAboveTabBar(page, page.locator('.bold-room-composer'))
      await expectAtLeast44(page.getByRole('button', { name: 'Open thread for Activity feed' }))
      for (const label of ['Job menu', 'Show deleted messages'])
        await expectAtLeast44(page.getByRole('button', { name: label }))
      await expectAtLeast44(page.getByRole('button', { name: 'Open side panel' }))

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

      await page.getByRole('button', { name: 'Back to jobs' }).click()
      await expect(page).toHaveURL('/b')
      await expect(page.getByRole('region', { name: 'Jobs' })).toBeVisible()
    })

    test('answers the pinned approval in place and reports the POST', async ({ page }) => {
      const state = await openBoldRoom(page)
      const card = page.getByRole('article', { name: /Needs you: May I install a package/ })
      await expect(card).toContainText('npm install ws@8')
      await expectAtLeast44(card.getByRole('button', { name: 'Allow' }))
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
      const opener = page.getByRole('button', { name: 'Open side panel' }).first()
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

    test('Room, Team and Settings each keep the tab bar and content above it', async ({
      page,
    }, testInfo) => {
      await openBoldRoom(page)
      await expectTabBar(page, 'Room')

      await tabs(page).getByRole('button', { name: 'Team' }).click()
      await expect(page).toHaveURL('/b/team')
      await expect(page.getByRole('heading', { name: 'Team', level: 1 })).toBeVisible()
      await expectTabBar(page, 'Team')
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
      await expectAboveTabBar(page, page.getByRole('navigation', { name: 'Settings' }))
      await page.screenshot({ path: testInfo.outputPath(`bold-phone-settings-${size.width}.png`) })

      await tabs(page).getByRole('button', { name: 'Room' }).click()
      await expect(page).toHaveURL('/b')
      await expectTabBar(page, 'Room')
      await expect(page.getByRole('region', { name: 'Jobs' })).toBeVisible()
    })
  })
}

for (const size of sizes) {
  test(`Team’s Message opens the one-to-one full screen at ${size.name}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: size.width, height: size.height })
    await pair(page)
    await page.goto('/b/team')
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
    await expectAtLeast44(panel.getByRole('button', { name: 'Send privately' }))
    await page.screenshot({ path: testInfo.outputPath(`bold-phone-one-to-one-${size.width}.png`) })

    await page.getByRole('button', { name: 'Back', exact: true }).click()
    // A phone one-to-one is a sheet over the room: Back closes it where it came from.
    await expect(page).toHaveURL('/b')
    await expect(panel).toBeHidden()
    await expect(page.getByRole('button', { name: 'Open side panel' })).toBeFocused()
    await expectTabBar(page, 'Room')
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
  await expect(page).toHaveURL('/b')
  await expect(panel).toBeHidden()
})
