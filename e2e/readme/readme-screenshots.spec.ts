import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'
import { fixtureNow } from '../now-fixture.ts'
import { orchestrationFixtures } from '../orchestration-fixtures.ts'
import { pair } from '../pair.ts'
import { teamRoomFixtures } from '../team-room-fixture.ts'
import { visualFixtures, visualHello } from '../visual-fixtures.ts'
import { okValidation, releaseDefinition, workflowFixtures } from '../workflow-fixtures.ts'

// Regenerates docs/screenshots/*.png for the README: `pnpm screenshots`. Most pictures come from a real fake-mode Score
// (the neutral demo team lead, builder, reviewer, designer; no Hermes, no model calls) that this config starts in a
// throwaway home. The two run pictures use the frozen e2e fixtures instead, so a run is caught at the same moment on
// every run. Nothing here shows a real profile, host or token.
const out = fileURLToPath(new URL('../../docs/screenshots/', import.meta.url))
mkdirSync(out, { recursive: true })

const web = { 'x-score-client': 'web' }
const desktop = { width: 1440, height: 900 }
const phone = { width: 390, height: 844 }

// Dark is the default look of the new shell.
test.use({ colorScheme: 'dark', reducedMotion: 'reduce', timezoneId: 'UTC', locale: 'en-GB' })

async function shot(page: Page, name: string) {
  await page.evaluate(() => document.fonts.ready)
  // Let the panels settle after their last read.
  await page.waitForTimeout(700)
  await expect(page.getByText(/^Loading/).locator('visible=true')).toHaveCount(0, {
    timeout: 15_000,
  })
  await page.screenshot({ path: `${out}${name}.png`, animations: 'disabled' })
}

async function openBold(page: Page, path = '/b') {
  await page.goto(path)
  await expect(page.locator('[data-ui="bold"]')).toBeVisible()
  await expect
    .poll(async () => (await page.request.get('/api/team-room')).status(), { timeout: 30_000 })
    .toBe(200)
}

const side = (page: Page) => page.locator('#bold-side-panel')

/** A fresh one-to-one chat with an agent, with the person's first message already sent. */
async function makeChat(page: Page, agent: string, text: string) {
  const made = await page.request.post(`/api/agents/${agent}/chats`, { headers: web, data: {} })
  expect(made.ok()).toBeTruthy()
  const chat = (await made.json()) as { id: string; roomId: string }
  const sent = await page.request.post(`/api/rooms/${chat.roomId}/messages`, {
    headers: { ...web, 'Idempotency-Key': `shot-${Date.now()}-${Math.random()}` },
    data: { text, jobId: chat.id },
  })
  expect(sent.ok()).toBeTruthy()
  return chat
}

async function openChat(page: Page, agent: string, chatId: string) {
  await page.goto(`/b?with=${agent}&chat=${chatId}`)
  await expect(side(page).locator('.bold-dm-thread')).toBeVisible({ timeout: 30_000 })
}

async function replyDone(page: Page) {
  await expect(
    side(page).locator('.bold-dm-message:not(:has(.chat-message--you))').first(),
  ).toBeVisible({ timeout: 30_000 })
  await expect(side(page).locator('.bold-dm-typing')).toHaveCount(0, { timeout: 30_000 })
  // The fake agent streams its words, then runs a few tools; the picture is taken once it has finished.
  await expect(side(page).getByText('ready for the next step.').first()).toBeVisible({
    timeout: 30_000,
  })
  await expect(side(page).getByText('Writing the reply')).toHaveCount(0, { timeout: 30_000 })
  await expect(side(page).getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, {
    timeout: 30_000,
  })
}

test.describe('the seeded fake team', () => {
  test.beforeEach(async ({ page }) => {
    await pair(page)
  })

  test('team room, desktop and phone', async ({ page }) => {
    await page.setViewportSize(desktop)
    await openBold(page)
    await expect(page.getByRole('tab', { name: /Activity feed/ })).toBeVisible()
    await shot(page, 'team-room')
    await page.setViewportSize(phone)
    await openBold(page)
    await shot(page, 'team-room-phone')
  })

  test('one to one', async ({ page }) => {
    await page.setViewportSize(desktop)
    const chat = await makeChat(page, 'lead', 'Can you summarise where the release notes stand?')
    await openChat(page, 'lead', chat.id)
    await replyDone(page)
    await shot(page, 'one-to-one')
  })

  test('start a job', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1250 })
    await openBold(page, '/b?start=job')
    const dialog = page.getByRole('dialog', { name: 'Start a job' })
    await expect(dialog).toBeVisible()
    await dialog
      .getByLabel('What should the team do?')
      .fill('Write the release notes for 2.4 and have them reviewed before Friday.')
    await expect(dialog.getByRole('button', { name: 'Start the job' })).toBeVisible()
    await shot(page, 'start-job')
  })

  test('recipes editor', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    const made = await page.request.post('/api/workflows', {
      headers: web,
      data: { definition: { ...releaseDefinition, name: 'Release notes' } },
    })
    expect(made.ok()).toBe(true)
    const id = ((await made.json()) as { workflowId: string }).workflowId
    await openBold(page, `/b/recipes/${id}`)
    await expect(page.getByRole('region', { name: 'Recipe editor' })).toBeVisible()
    await expect(page.locator('[data-node]').first()).toBeVisible()
    await shot(page, 'recipes')
  })

  test('agent page', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    await openBold(page, '/b/team/builder')
    await expect(page.getByRole('heading', { name: /builder/ }).first()).toBeVisible()
    await shot(page, 'agent')
  })

  test('agent screen (Watch)', async ({ page }) => {
    await page.setViewportSize(desktop)
    await openBold(page, '/b/screen/builder')
    await expect(page.getByRole('heading', { name: 'builder’s screen' })).toBeVisible()
    await shot(page, 'screen')
  })

  test('library', async ({ page }) => {
    await page.setViewportSize(desktop)
    await openBold(page)
    await page.locator('button.side-toggle').click()
    await page.getByRole('button', { name: /^Library/ }).click()
    await expect(page.getByTestId('bold-library')).toBeVisible()
    await shot(page, 'library')
  })

  test('search', async ({ page }) => {
    await page.setViewportSize(desktop)
    await openBold(page)
    await page.getByRole('button', { name: 'Search', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Search and commands' })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('combobox', { name: 'Search or run a command' }).fill('release')
    await shot(page, 'search')
  })

  test('settings usage', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    await openBold(page, '/b/settings/usage')
    await expect(page.getByRole('region', { name: 'Usage in numbers' })).toBeVisible()
    await expect(page.getByRole('region', { name: 'Spend by agent' })).toBeVisible()
    await shot(page, 'usage')
  })

  test('settings look', async ({ page }) => {
    await page.setViewportSize(desktop)
    await openBold(page, '/b/settings/look')
    await shot(page, 'look')
  })

  test('customizer', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    await openBold(page, '/b/settings/look/customize')
    await expect(page.getByRole('heading', { name: 'Customizer' })).toBeVisible()
    await expect(
      page
        .frameLocator('iframe[title="Preview of your theme"]')
        .locator('[data-ui="bold"]')
        .first(),
    ).toBeVisible({ timeout: 20_000 })
    await page.waitForTimeout(800)
    // The live contrast check under the preview is left out: it is not part of the layout to show.
    await page.locator('.cz-checks').evaluate((el) => ((el as HTMLElement).style.display = 'none'))
    await shot(page, 'customizer')
  })

  test('approval card', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1300 })
    const room = await page.request.get('/api/team-room')
    const roomId = ((await room.json()) as { room: { id: string } }).room.id
    const sent = await page.request.post(`/api/rooms/${roomId}/messages`, {
      headers: { ...web, 'Idempotency-Key': `shot-${Date.now()}` },
      data: { text: '@designer Please ask for approval before installing the websocket library' },
    })
    expect(sent.ok()).toBe(true)
    await openBold(page)
    const card = page
      .getByRole('region', { name: 'Needs you' })
      .getByRole('article', { name: /^Needs you: Install the websocket library/ })
    await expect(async () => {
      const more = page.getByRole('button', { name: /more needs? you/ })
      if (!(await card.isVisible()) && (await more.isVisible())) await more.click()
      await expect(card.getByRole('button', { name: 'Allow', exact: true })).toBeVisible({
        timeout: 1_000,
      })
    }).toPass({ timeout: 30_000 })
    await shot(page, 'needs-you')
  })

  test('try another reply', async ({ page }) => {
    await page.setViewportSize(desktop)
    const chat = await makeChat(page, 'designer', 'Suggest a name for the 2.4 release.')
    await openChat(page, 'designer', chat.id)
    await replyDone(page)
    const row = side(page).locator('.bold-dm-message:not(:has(.chat-message--you))').first()
    await row.hover()
    const button = row.getByRole('button', { name: /^Try another reply from/ })
    await expect(button).toBeEnabled({ timeout: 30_000 })
    await button.click()
    await expect(side(page).locator('.bold-reply-group').getByText('2 / 2')).toBeVisible({
      timeout: 30_000,
    })
    await replyDone(page)
    await shot(page, 'try-another')
  })

  test('question card', async ({ page }) => {
    await page.setViewportSize(desktop)
    const chat = await makeChat(page, 'builder', 'ask me to pick')
    await openChat(page, 'builder', chat.id)
    await expect(side(page).getByRole('region', { name: 'builder asks' })).toBeVisible({
      timeout: 30_000,
    })
    await shot(page, 'question')
  })
})

// The two run pictures: a frozen orchestration and a frozen recipe run, from the e2e fixtures.
test.describe('frozen runs', () => {
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
        await route.fulfill({
          status: 404,
          json: { error: { code: 'not_found', message: 'none' } },
        })
        return
      }
      await route.fulfill({ json: fixture })
    })
  })

  test('run steps and graph', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1100 })
    await page.goto('/b?run=brief-orch-1')
    await expect(page.getByRole('list', { name: 'Steps' })).toBeVisible()
    await shot(page, 'run-steps')
    await page.getByRole('tab', { name: 'Graph' }).click()
    await expect(page.locator('[data-node="s2"]')).toBeVisible()
    await shot(page, 'run-graph')
  })
})
