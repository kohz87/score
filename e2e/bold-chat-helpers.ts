import { expect, type Page } from '@playwright/test'

// Helpers for the team-room specs that run against the real fake server (the 3.0.0 port of the classic Chat specs).
const web = { 'x-score-client': 'web' }

/** A room of its own with a short unique name: specs share one server and the seeded rooms move over time. */
export async function makeRoom(
  page: Page,
  tag: string,
  members: string[] = ['lead'],
  leadAgentId = 'lead',
) {
  const name = `${tag}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
  const response = await page.request.post('/api/rooms', {
    headers: web,
    data: { name, leadAgentId, members },
  })
  expect(response.ok()).toBe(true)
  const room = (await response.json()) as { id: string; name: string }
  return { ...room, label: `#${name}` }
}

export async function say(page: Page, roomId: string, text: string) {
  const response = await page.request.post(`/api/rooms/${roomId}/messages`, {
    headers: web,
    data: { text, to: ['lead'] },
  })
  expect(response.ok()).toBe(true)
}

export const composerOf = (page: Page) => page.getByRole('combobox', { name: /^Message/ })

/** The room's message stream (the new shell's name for the classic "Message history" region). */
export const streamOf = (page: Page) => page.locator('#bold-room-stream')

/** Opens an older room in the new shell and waits for its composer. */
export async function openBoldRoomById(page: Page, id: string) {
  await page.goto(`/b?room=${id}`)
  await expect(composerOf(page)).toBeEnabled({ timeout: 30_000 })
}

/** One message of the stream by its text. */
export const messageWith = (page: Page, text: string | RegExp) =>
  streamOf(page).locator('.bold-message', { hasText: text })

/** The hover action row under a message (the classic in-article row is hidden in the new shell). */
export const actsOf = (message: ReturnType<typeof messageWith>) => message.locator('.bold-acts')

/** Sends a message and waits until the reply to it (a new one, not an earlier one) has arrived and nothing is still being written. */
export async function sendAndWait(
  page: Page,
  text: string,
  reply = 'I have reviewed the room context',
) {
  const composer = composerOf(page)
  const replies = streamOf(page)
    .getByRole('article', { name: /^Message from (?!You)/ })
    .filter({ hasText: reply })
  const before = await replies.count()
  await composer.fill(text)
  await composer.press('Enter')
  const mine = messageWith(page, text)
  await expect(mine).toBeVisible()
  await expect(replies).toHaveCount(before + 1, { timeout: 40_000 })
  await expect(streamOf(page).getByRole('button', { name: /^Stop reply/ })).toHaveCount(0)
  return mine
}
