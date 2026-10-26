import { expect, test, type Page } from '@playwright/test'
import { holdLockPerTest } from './locks.ts'
import { pair } from './pair.ts'

// 2.3.0 (decision 128): an agent's question is a needs-you card of its own. The fake adapter asks when a message says
// "ask me" (free text), "ask me to pick" (main / develop) or "ask me to choose several" (staging / production / preview).
test.use({ reducedMotion: 'reduce' })

const web = { 'x-score-client': 'web' }
const sizes = [
  { name: '1440×900', viewport: { width: 1440, height: 900 } },
  { name: '390×844', viewport: { width: 390, height: 844 } },
] as const

function tag(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

const side = (page: Page) => page.locator('#bold-side-panel')

/** A fresh one-to-one chat with builder, opened in the side panel; returns the composer. */
async function openChat(page: Page) {
  const made = await page.request.post('/api/agents/builder/chats', {
    headers: web,
    data: { title: tag('Question chat') },
  })
  expect(made.status()).toBe(201)
  const chat = (await made.json()) as { id: string }
  await page.goto(`/b?with=builder&chat=${chat.id}`)
  const composer = side(page).getByPlaceholder('Message builder privately')
  await expect(composer).toBeVisible()
  return composer
}

async function ask(page: Page, text: string) {
  const composer = await openChat(page)
  await composer.fill(text)
  await composer.press('Enter')
}

holdLockPerTest('builder-questions')

for (const { name, viewport } of sizes) {
  test.describe(`agent questions at ${name}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize(viewport)
      await pair(page)
    })

    test('a free-text question is answered in a one-to-one and leaves a muted line', async ({
      page,
    }) => {
      await ask(page, 'ask me something')
      const card = side(page).getByRole('region', { name: 'builder asks' })
      await expect(card).toBeVisible({ timeout: 30_000 })
      await expect(card).toHaveAttribute('data-protected', /.+/)
      await expect(card).toContainText('What should the release be called?')
      const answer = card.getByRole('textbox')
      await expect(answer).not.toBeFocused()
      await answer.fill('Aurora')
      await answer.press('Enter')
      await expect(card).toHaveCount(0, { timeout: 30_000 })
      await expect(side(page).locator('.bold-dm-thread')).toContainText(
        'Thanks, going with Aurora.',
        { timeout: 30_000 },
      )
      await expect(side(page).locator('.bold-question-note')).toContainText(
        'builder asked: What should the release be called? — you answered: Aurora',
      )
    })

    test('a single-select question is answered by tapping an option', async ({ page }) => {
      await ask(page, 'ask me to pick')
      const card = side(page).getByRole('region', { name: 'builder asks' })
      await expect(card).toBeVisible({ timeout: 30_000 })
      await expect(card.getByRole('button', { name: 'develop' })).toBeVisible()
      await card.getByRole('button', { name: 'main' }).click()
      await expect(card).toHaveCount(0, { timeout: 30_000 })
      await expect(side(page).locator('.bold-dm-thread')).toContainText(
        'Thanks, going with main.',
        { timeout: 30_000 },
      )
    })

    test('a multi-select question needs a pick, then sends them together', async ({ page }) => {
      await ask(page, 'ask me to choose several')
      const card = side(page).getByRole('region', { name: 'builder asks' })
      await expect(card).toBeVisible({ timeout: 30_000 })
      const send = card.getByRole('button', { name: 'Send' })
      await expect(send).toBeDisabled()
      const staging = card.getByRole('button', { name: 'staging' })
      await staging.click()
      await expect(staging).toHaveAttribute('aria-pressed', 'true')
      await card.getByRole('button', { name: 'preview' }).click()
      await send.click()
      await expect(card).toHaveCount(0, { timeout: 30_000 })
      await expect(side(page).locator('.bold-dm-thread')).toContainText(
        'Thanks, going with staging and preview.',
        { timeout: 30_000 },
      )
    })

    test('a team-room question joins Needs you and leaves it when answered', async ({ page }) => {
      test.setTimeout(90_000)
      await page.goto('/b')
      await expect
        .poll(async () => (await page.request.get('/api/team-room')).status(), { timeout: 30_000 })
        .toBe(200)
      const team = (await (await page.request.get('/api/team-room')).json()) as {
        room: { id: string }
      }
      const sent = await page.request.post(`/api/rooms/${team.room.id}/messages`, {
        headers: { ...web, 'Idempotency-Key': tag('ask') },
        data: { text: '@reviewer ask me to pick' },
      })
      expect(sent.status(), await sent.text()).toBeLessThan(300)
      const strip = page.getByRole('region', { name: 'Needs you' })
      const card = strip.getByRole('region', { name: 'reviewer asks' })
      // The strip folds to its first card; the count button opens the rest.
      await expect(page.getByRole('button', { name: /more need you/ })).toBeVisible({
        timeout: 30_000,
      })
      await page.getByRole('button', { name: /more need you/ }).click()
      await expect(card).toBeVisible({ timeout: 30_000 })
      // The dock ring says the agent needs you while the question waits (a phone has no dock).
      const ring = page.getByRole('button', { name: /^One to one with reviewer,/ })
      if (viewport.width > 860) await expect(ring).toHaveAccessibleName(/needs you/)
      await card.getByRole('button', { name: 'develop' }).click()
      await expect(card).toHaveCount(0, { timeout: 30_000 })
      if (viewport.width > 860) {
        await expect(ring).not.toHaveAccessibleName(/needs you/, { timeout: 30_000 })
        await expect(page.locator('.bold-question-note').last()).toContainText(
          'you answered: develop',
        )
      }
    })
  })
}
