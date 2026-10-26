import { expect, test, type Page } from '@playwright/test'
import { pair } from './pair.ts'

// 2.4.0 (decision 130): Try another reply against the fake adapter: versions of a reply show as one message with a
// pager, and on a phone a sideways swipe changes the version.
test.use({ reducedMotion: 'reduce' })

const web = { 'x-score-client': 'web' }
const side = (page: Page) => page.locator('#bold-side-panel')

async function makeChat(page: Page, agent: string, text: string) {
  const made = await page.request.post(`/api/agents/${agent}/chats`, { headers: web, data: {} })
  expect(made.ok()).toBeTruthy()
  const chat = (await made.json()) as { id: string; roomId: string }
  const sent = await page.request.post(`/api/rooms/${chat.roomId}/messages`, {
    headers: { ...web, 'Idempotency-Key': `mk-${Date.now()}-${Math.random()}` },
    data: { text, jobId: chat.id },
  })
  expect(sent.ok()).toBeTruthy()
  return chat
}

async function open(page: Page, agent: string, chatId: string) {
  await page.goto(`/b?with=${agent}&chat=${chatId}`)
  await expect(side(page).locator('.bold-dm-thread')).toBeVisible({ timeout: 30_000 })
}

const group = (page: Page) => side(page).locator('.bold-reply-group')

async function tryAnother(page: Page) {
  const reply = group(page)
    .count()
    .then((n) =>
      n
        ? group(page)
        : side(page).locator('.bold-dm-message:not(:has(.chat-message--you))').first(),
    )
  const row = await reply
  await row.hover()
  const button = row.getByRole('button', { name: /^Try another reply from/ })
  await expect(button).toBeEnabled({ timeout: 30_000 })
  await button.click()
}

const sizes = [
  { name: '1440×900', viewport: { width: 1440, height: 900 }, agent: 'designer', touch: false },
  { name: '390×844', viewport: { width: 390, height: 844 }, agent: 'lead', touch: true },
] as const

for (const size of sizes) {
  test.describe.serial(`try another at ${size.name}`, () => {
    test.use({ viewport: size.viewport, hasTouch: size.touch })
    test.beforeEach(async ({ page }) => {
      await pair(page)
    })

    test('two more versions make 3 / 3, the pager goes back, and the note shows', async ({
      page,
    }) => {
      const chat = await makeChat(page, size.agent, `Question try-${Date.now().toString(36)}`)
      await open(page, size.agent, chat.id)
      await expect(
        side(page).locator('.bold-dm-message:not(:has(.chat-message--you))').first(),
      ).toBeVisible({ timeout: 30_000 })
      await expect(side(page).locator('.bold-dm-typing')).toHaveCount(0, { timeout: 30_000 })
      await expect(side(page).getByText('remembers its earlier answers')).toHaveCount(0)

      await tryAnother(page)
      await expect(group(page).getByText('2 / 2')).toBeVisible({ timeout: 30_000 })
      await expect(side(page).locator('.bold-dm-typing')).toHaveCount(0, { timeout: 30_000 })
      await tryAnother(page)
      await expect(group(page).getByText('3 / 3')).toBeVisible({ timeout: 30_000 })
      await expect(side(page).locator('.bold-dm-typing')).toHaveCount(0, { timeout: 30_000 })
      // One message, however many versions.
      await expect(group(page)).toHaveCount(1)
      await expect(side(page).getByText(/remembers its earlier answers/)).toBeVisible()

      await group(page).getByRole('button', { name: 'Previous version' }).click()
      await group(page).getByRole('button', { name: 'Previous version' }).click()
      await expect(group(page).getByText('1 / 3')).toBeVisible()
      await expect(group(page).getByText('Version 1 of 3')).toBeAttached()
    })

    if (size.touch)
      test('a sideways swipe changes the version', async ({ page }) => {
        const chat = await makeChat(page, size.agent, `Question swipe-${Date.now().toString(36)}`)
        await open(page, size.agent, chat.id)
        await expect(side(page).locator('.bold-dm-typing')).toHaveCount(0, { timeout: 30_000 })
        await expect(
          side(page).locator('.bold-dm-message:not(:has(.chat-message--you))').first(),
        ).toBeVisible({ timeout: 30_000 })
        await tryAnother(page)
        await expect(group(page).getByText('2 / 2')).toBeVisible({ timeout: 30_000 })
        await expect(side(page).locator('.bold-dm-typing')).toHaveCount(0, { timeout: 30_000 })

        const swipe = (dx: number, dy: number) =>
          group(page).evaluate(
            (node, [x, y]) => {
              const point = (cx: number, cy: number) =>
                new Touch({ identifier: 1, target: node, clientX: cx, clientY: cy })
              node.dispatchEvent(
                new TouchEvent('touchstart', {
                  bubbles: true,
                  cancelable: true,
                  touches: [point(200, 300)],
                }),
              )
              node.dispatchEvent(
                new TouchEvent('touchend', {
                  bubbles: true,
                  cancelable: true,
                  changedTouches: [point(200 + x!, 300 + y!)],
                }),
              )
            },
            [dx, dy],
          )
        await swipe(90, 4)
        await expect(group(page).getByText('1 / 2')).toBeVisible()
        await swipe(90, 80)
        await expect(group(page).getByText('1 / 2')).toBeVisible()
        await swipe(-90, 4)
        await expect(group(page).getByText('2 / 2')).toBeVisible()
      })
  })
}
