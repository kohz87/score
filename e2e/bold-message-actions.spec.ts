import { expect, test, type Page } from '@playwright/test'
import { pair } from './pair.ts'

// PLAN 2.0.11: the message actions (Edit, Copy, Retry, Pin, Delete) and the chat delete are in the one-to-one chat too,
// against the fake adapter. Each test makes its own chat so nothing else's seeded history changes.
test.use({ reducedMotion: 'reduce' })

const web = { 'x-score-client': 'web' }
const sizes = [
  { name: '1440×900', viewport: { width: 1440, height: 900 }, agent: 'designer' },
  { name: '390×844', viewport: { width: 390, height: 844 }, agent: 'lead' },
] as const

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

/** The fake agent answers a new message, and Edit, Delete and Delete chat wait until it has finished. */
async function settled(page: Page, roomId: string, chatId: string) {
  const replies = side(page).locator('.bold-dm-message:not(:has(.chat-message--you))')
  await expect(replies.first()).toBeVisible({ timeout: 30_000 })
  await expect(side(page).locator('.bold-dm-typing')).toHaveCount(0, { timeout: 30_000 })
  await expect(side(page).getByRole('button', { name: /^Stop/ })).toHaveCount(0, {
    timeout: 30_000,
  })
  // The server's own view: no run pending or active, which is what lets a rewind or a delete through.
  const page_ = (await (
    await page.request.get(`/api/rooms/${roomId}/messages?jobId=${chatId}`)
  ).json()) as {
    items: { id: string; author: { kind: string } }[]
  }
  const own = page_.items.find((item) => item.author.kind === 'you')!
  await expect
    .poll(
      async () =>
        (
          (await (
            await page.request.get(`/api/rooms/${roomId}/messages/${own.id}/rewind-plan`)
          ).json()) as { blocked: string | null }
        ).blocked,
      { timeout: 30_000 },
    )
    .toBeNull()
}

async function openChat(page: Page, agent: string, chatId: string) {
  await page.goto(`/b?with=${agent}&chat=${chatId}`)
  await expect(side(page).locator('.bold-dm-thread')).toBeVisible({ timeout: 30_000 })
}

// A rewind or a delete waits while anything in the same room is running, so each size works in its own agent's room
// (the other specs use builder and reviewer) and the tests of one size run one after another.
for (const { name, viewport, agent } of sizes) {
  test.describe.serial(`one-to-one message actions at ${name}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize(viewport)
      await pair(page)
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    })

    test('copy, pin, delete and edit your own message', async ({ page }) => {
      const tag = `act-${Date.now().toString(36)}`
      const chat = await makeChat(page, agent, `First ${tag}`)
      await openChat(page, agent, chat.id)
      await settled(page, chat.roomId, chat.id)
      const mine = side(page).locator('.bold-dm-message', { hasText: `First ${tag}` })
      await expect(mine).toBeVisible()
      await mine.hover()
      await expect(mine.getByRole('button', { name: 'Edit message from You' })).toBeVisible()
      await mine.getByRole('button', { name: 'Copy message from You' }).click()
      await expect(mine.getByRole('button', { name: 'Copy message from You' })).toHaveText('Copied')
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`First ${tag}`)

      await mine.getByRole('button', { name: 'Pin message from You' }).click()
      await expect(mine.getByRole('button', { name: 'Unpin message from You' })).toBeVisible()

      // Edit: the message loads into this chat's composer, the rewind is confirmed, the correction replaces it.
      await mine.getByRole('button', { name: 'Edit message from You' }).click()
      const composer = side(page).getByPlaceholder(`Message ${agent} privately`)
      await expect(composer).toHaveValue(`First ${tag}`)
      await composer.fill(`Corrected ${tag}`)
      await side(page).getByRole('button', { name: 'Send correction', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'Edit and send again?' })
      await expect(dialog).toBeVisible()
      await dialog.getByRole('button', { name: 'Rewind and edit' }).click()
      await expect(
        side(page).locator('.bold-dm-message', { hasText: `Corrected ${tag}` }),
      ).toBeVisible({
        timeout: 20_000,
      })
      await expect(side(page).getByText(`First ${tag}`)).toHaveCount(0)
    })

    test('retry an agent reply, then delete a message', async ({ page }) => {
      const tag = `retry-${Date.now().toString(36)}`
      const chat = await makeChat(page, agent, `Question ${tag}`)
      await openChat(page, agent, chat.id)
      const replies = side(page).locator('.bold-dm-message:not(:has(.chat-message--you))')
      await settled(page, chat.roomId, chat.id)
      const before = await replies.count()
      await replies.first().hover()
      await replies
        .first()
        .getByRole('button', { name: /^Retry reply from/ })
        .click()
      await expect.poll(() => replies.count(), { timeout: 30_000 }).toBeGreaterThan(before)
      await settled(page, chat.roomId, chat.id)

      const mine = side(page).locator('.bold-dm-message', { hasText: `Question ${tag}` })
      await mine.hover()
      await mine.getByRole('button', { name: 'Delete message from You' }).click()
      const rewind = page.getByRole('dialog', { name: 'Delete this message?' })
      await rewind.getByRole('button', { name: /^Rewind and delete/ }).click()
      await expect(side(page).getByText(`Question ${tag}`)).toHaveCount(0, { timeout: 20_000 })
      await side(page).getByRole('button', { name: 'Chat menu' }).click()
      await page.getByRole('menuitemcheckbox', { name: 'Show deleted messages' }).click()
      await expect(
        side(page).getByRole('region', { name: 'Deleted messages' }).first(),
      ).toBeVisible()
    })

    test('delete the chat from its menu, with an undo', async ({ page }) => {
      const tag = `gone-${Date.now().toString(36)}`
      const chat = await makeChat(page, agent, `Bye ${tag}`)
      await openChat(page, agent, chat.id)
      await settled(page, chat.roomId, chat.id)
      await side(page).getByRole('button', { name: 'Chat menu' }).click()
      await page.getByRole('menuitem', { name: 'Delete chat' }).click()
      const dialog = page.getByRole('dialog', { name: /^Delete this chat with/ })
      await expect(dialog).toHaveAttribute('data-protected', 'any')
      await expect(dialog.getByText(/not touched/)).toBeVisible()
      await dialog.getByRole('button', { name: 'Delete chat' }).click()
      await expect(dialog).toHaveCount(0)
      await expect(page.getByText(/Job deleted/)).toBeVisible()
      await expect
        .poll(async () => {
          const direct = (await (await page.request.get(`/api/agents/${agent}/direct`)).json()) as {
            chats: { id: string }[]
          }
          return direct.chats.some((item) => item.id === chat.id)
        })
        .toBe(false)
    })

    test('Clear chat empties the main chat and keeps other chats', async ({ page }) => {
      const tag = `clear-${Date.now().toString(36)}`
      const other = await makeChat(page, agent, `Other ${tag}`)
      const direct = (await (await page.request.get(`/api/agents/${agent}/direct`)).json()) as {
        chats: { id: string; isDefault: boolean }[]
      }
      const main = direct.chats.find((item) => item.isDefault)
      expect(main, 'the direct room has a main chat').toBeDefined()
      const sent = await page.request.post(`/api/rooms/${other.roomId}/messages`, {
        headers: { ...web, 'Idempotency-Key': `mk-${Date.now()}-${Math.random()}` },
        data: { text: `Main ${tag}`, jobId: main!.id },
      })
      expect(sent.ok()).toBeTruthy()
      await openChat(page, agent, main!.id)
      await settled(page, other.roomId, main!.id)
      await expect(side(page).getByText(`Main ${tag}`)).toBeVisible()
      await side(page).getByRole('button', { name: 'Chat menu' }).click()
      await expect(page.getByRole('menuitem', { name: 'Delete chat' })).toHaveCount(0)
      await page.getByRole('menuitem', { name: 'Clear chat' }).click()
      const dialog = page.getByRole('dialog', { name: /^Clear this chat with/ })
      await expect(dialog).toHaveAttribute('data-protected', 'any')
      await dialog.getByRole('button', { name: 'Clear chat' }).click()
      await expect(dialog.getByRole('status')).toHaveText(/^Cleared \d+ messages?\.$/)
      await dialog.getByRole('button', { name: 'Done' }).click()
      await expect(side(page).getByText(`Main ${tag}`)).toHaveCount(0)
      const after = (await (await page.request.get(`/api/agents/${agent}/direct`)).json()) as {
        chats: { id: string }[]
      }
      expect(after.chats.some((item) => item.id === other.id)).toBe(true)
    })
  })
}
