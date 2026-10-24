import { expect, test, type Page } from '@playwright/test'
import { pair } from './pair.ts'

const web = { 'x-score-client': 'web' }
const sizes = [
  { name: '1440×900', viewport: { width: 1440, height: 900 } },
  { name: '390×844', viewport: { width: 390, height: 844 } },
] as const

function tag(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

async function openBold(page: Page) {
  await page.goto('/b')
  await expect(page.locator('[data-ui="bold"]')).toBeVisible()
}

async function openSearch(page: Page) {
  await page.getByRole('button', { name: 'Search', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Search and commands' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('combobox', { name: 'Search or run a command' })).toBeFocused()
  const box = await dialog.boundingBox()
  const viewport = page.viewportSize()
  expect(box).not.toBeNull()
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual((viewport?.width ?? 0) + 0.5)
  return dialog
}

async function teamRoom(page: Page) {
  await expect
    .poll(async () => (await page.request.get('/api/team-room')).status(), { timeout: 30_000 })
    .toBe(200)
  const response = await page.request.get('/api/team-room')
  return (await response.json()) as { room: { id: string; name: string } }
}

async function makeJob(page: Page, title: string) {
  const team = await teamRoom(page)
  const response = await page.request.post(`/api/rooms/${team.room.id}/jobs`, {
    headers: web,
    data: { title },
  })
  expect(response.status()).toBe(201)
  return (await response.json()) as { id: string; title: string }
}

async function makeChat(page: Page, title: string, text: string) {
  const made = await page.request.post('/api/agents/builder/chats', {
    headers: web,
    data: { title },
  })
  expect(made.status()).toBe(201)
  const chat = (await made.json()) as { id: string; roomId: string; title: string }
  const sent = await page.request.post(`/api/rooms/${chat.roomId}/messages`, {
    headers: web,
    data: { text, jobId: chat.id },
  })
  expect(sent.ok()).toBe(true)
  const message = (await sent.json()) as { message: { id: string } }
  return { chat, messageId: message.message.id }
}

async function makeJobMessage(page: Page, jobId: string, text: string) {
  const team = await teamRoom(page)
  const sent = await page.request.post(`/api/rooms/${team.room.id}/messages`, {
    headers: web,
    data: { text, jobId },
  })
  expect(sent.ok()).toBe(true)
  return ((await sent.json()) as { message: { id: string } }).message.id
}

for (const size of sizes) {
  test.describe(`bold search at ${size.name}`, () => {
    test.use({ viewport: size.viewport })

    test('a team-room job opens with its job link', async ({ page }) => {
      await pair(page)
      await openBold(page)
      const title = tag('Job search')
      const job = await makeJob(page, title)
      await openSearch(page)
      await page.getByRole('combobox', { name: 'Search or run a command' }).fill(title)
      await page.getByRole('option', { name: new RegExp(title) }).click()
      await expect(page).not.toHaveURL(/[?&]message=/)
      expect(new URL(page.url()).searchParams.get('job')).toBe(job.id)
    })

    test('a one-to-one chat opens its agent route', async ({ page }) => {
      await pair(page)
      await openBold(page)
      const title = tag('Chat search')
      const { chat } = await makeChat(page, title, `${title} message`)
      await openSearch(page)
      await page.getByRole('combobox', { name: 'Search or run a command' }).fill(title)
      await page.getByRole('option', { name: new RegExp(title) }).click()
      const url = new URL(page.url())
      expect(url.pathname).toBe('/b')
      expect(url.searchParams.get('with')).toBe('builder')
      expect(url.searchParams.get('chat')).toBe(chat.id)
    })

    test('a Library note opens with its path', async ({ page }) => {
      await pair(page)
      await openBold(page)
      await openSearch(page)
      await page.getByRole('combobox', { name: 'Search or run a command' }).fill('Roadmap')
      await page
        .getByRole('option', { name: /Roadmap/ })
        .first()
        .click()
      const url = new URL(page.url())
      expect(url.pathname).toBe('/b')
      expect(url.searchParams.get('note')).toBe('Projects/Roadmap.md')
    })

    test('a team-room message opens its job and message', async ({ page }) => {
      await pair(page)
      await openBold(page)
      const text = tag('Message search')
      const job = await makeJob(page, `${text} job`)
      const messageId = await makeJobMessage(page, job.id, text)
      await openSearch(page)
      await page.getByRole('combobox', { name: 'Search or run a command' }).fill(text)
      await page
        .getByRole('group', { name: 'Messages' })
        .getByRole('option', { name: new RegExp(text) })
        .click()
      const url = new URL(page.url())
      expect(url.pathname).toBe('/b')
      expect(url.searchParams.get('job')).toBe(job.id)
      expect(url.searchParams.get('message')).toBe(messageId)
    })

    test('a two-word message query finds its one-to-one message', async ({ page }) => {
      await pair(page)
      await openBold(page)
      const first = `heed${Date.now().toString(36).slice(-4)}`
      const second = `mark${Math.random().toString(36).slice(2, 6)}`
      const { chat } = await makeChat(
        page,
        `${first} ${second} chat`,
        `${first} ${second} together`,
      )
      await openSearch(page)
      const input = page.getByRole('combobox', { name: 'Search or run a command' })
      await input.fill(`${first} ${second}`)
      await page
        .getByRole('group', { name: 'Messages' })
        .getByRole('option', { name: new RegExp(first) })
        .click()
      const url = new URL(page.url())
      expect(url.pathname).toBe('/b')
      expect(url.searchParams.get('job')).toBeNull()
      expect(url.searchParams.get('with')).toBe('builder')
      expect(url.searchParams.get('chat')).toBe(chat.id)
    })

    test('an action opens the start-a-job route', async ({ page }) => {
      await pair(page)
      await openBold(page)
      await openSearch(page)
      await page.getByRole('combobox', { name: 'Search or run a command' }).fill('Start a job')
      await page.getByRole('option', { name: 'Start a job' }).click()
      expect(new URL(page.url()).searchParams.get('start')).toBe('job')
    })

    test('a settings section opens its page', async ({ page }) => {
      await pair(page)
      await openBold(page)
      await openSearch(page)
      await page.getByRole('combobox', { name: 'Search or run a command' }).fill('Settings: Look')
      await page.getByRole('option', { name: 'Settings: Look' }).click()
      await expect(page).toHaveURL('/b/settings/look')
    })

    test('Reset look clears this device’s look', async ({ page }) => {
      await pair(page)
      await openBold(page)
      await page.evaluate(() => window.localStorage.removeItem('score.look.device'))
      await openSearch(page)
      await page.getByRole('combobox', { name: 'Search or run a command' }).fill('Reset look')
      await page.getByRole('option', { name: 'Reset look on this device' }).click()
      await expect(page.getByRole('dialog', { name: 'Search and commands' })).toHaveCount(0)
      expect(await page.evaluate(() => window.localStorage.getItem('score.look.device'))).toBe(
        'score',
      )
    })

    test('a slash command comes from /api/commands and opens as a command link', async ({
      page,
    }) => {
      await pair(page)
      await openBold(page)
      await openSearch(page)
      await page.getByRole('combobox', { name: 'Search or run a command' }).fill('/as')
      await page.getByRole('option', { name: /^\/assign/ }).click()
      // The room (11.4a) takes `?command=` into its composer and drops it from the address, so check where it landed.
      await expect(page.locator('.chat-composer textarea').first()).toHaveValue(/^\/assign/)
    })

    test('Control+K opens search from inside a focused composer or editor', async ({ page }) => {
      await pair(page)
      await openBold(page)
      // The room's composer arrives in 11.4; this pins the shell-wide shortcut against an editable field now.
      await page.locator('main').evaluate((main) => {
        const composer = document.createElement('textarea')
        composer.setAttribute('aria-label', 'Composer draft')
        main.append(composer)
      })
      const composer = page.getByRole('textbox', { name: 'Composer draft' })
      await composer.focus()
      await expect(composer).toBeFocused()
      await page.keyboard.press('Control+K')
      const dialog = page.getByRole('dialog', { name: 'Search and commands' })
      await expect(dialog).toBeVisible()
      await expect(dialog.getByRole('combobox', { name: 'Search or run a command' })).toBeFocused()
    })

    test('Tab and Shift+Tab stay inside the search dialog', async ({ page }) => {
      await pair(page)
      await openBold(page)
      const dialog = await openSearch(page)
      const input = dialog.getByRole('combobox', { name: 'Search or run a command' })
      const close = dialog.getByRole('button', { name: 'Close search' })

      await page.keyboard.press('Tab')
      await expect(close).toBeFocused()
      await page.keyboard.press('Tab')
      await expect(input).toBeFocused()
      await page.keyboard.press('Shift+Tab')
      await expect(close).toBeFocused()
    })

    test('the keyboard path moves, opens and returns focus to the trigger', async ({
      page,
    }, testInfo) => {
      await pair(page)
      await openBold(page)
      const prefix = tag('Keyboard search')
      const first = await makeJob(page, `${prefix} alpha`)
      await makeJob(page, `${prefix} beta`)

      const trigger = page.getByRole('button', { name: 'Search', exact: true })
      await trigger.focus()
      await page.keyboard.press('Control+K')
      const input = page.getByRole('combobox', { name: 'Search or run a command' })
      await expect(input).toBeFocused()
      await input.fill(prefix)
      const options = page.getByRole('option')
      await expect(options).toHaveCount(2)
      await expect(options.first()).toHaveAttribute('aria-selected', 'true')
      await page.screenshot({ path: testInfo.outputPath(`bold-search-${size.name}.png`) })

      await page.keyboard.press('ArrowDown')
      await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true')
      await page.keyboard.press('ArrowUp')
      await expect(options.first()).toHaveAttribute('aria-selected', 'true')
      await page.keyboard.press('Enter')
      await expect(page.getByRole('dialog', { name: 'Search and commands' })).toHaveCount(0)
      expect(new URL(page.url()).searchParams.get('job')).toBe(first.id)

      await page.keyboard.press('Control+K')
      await expect(input).toBeFocused()
      await page.keyboard.press('Escape')
      await expect(page.getByRole('dialog', { name: 'Search and commands' })).toHaveCount(0)
      await expect(trigger).toBeFocused()
    })
  })
}
