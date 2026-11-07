import { expect, type Locator, type Page } from '@playwright/test'

// Helpers for the team-room specs that run against the real fake server (the 3.0.0 port of the classic Chat specs).
const web = { 'x-score-client': 'web' }

export type DirectChat = { id: string; roomId: string; title: string }

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

/** A direct chat owned by this test, optionally with its first message (which starts the agent's reply). */
export async function makeDirectChat(
  page: Page,
  agent: string,
  title: string,
  text?: string,
): Promise<DirectChat> {
  const response = await page.request.post(`/api/agents/${agent}/chats`, {
    headers: web,
    data: { title },
  })
  expect(response.status()).toBe(201)
  const chat = (await response.json()) as DirectChat
  if (text !== undefined) await postToChat(page, chat.roomId, chat.id, text)
  return chat
}

export async function postToChat(page: Page, roomId: string, chatId: string, text: string) {
  const response = await page.request.post(`/api/rooms/${roomId}/messages`, {
    headers: web,
    data: { text, jobId: chatId },
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

/** Opens a foldable Info section the way a person would: clicks its heading toggle when it is folded (3.27.1). */
export async function openInfoSection(scope: Page | Locator, title: string | RegExp) {
  const heading = scope.getByRole('heading', { name: title }).first()
  await expect(heading).toBeVisible()
  const toggle = heading.getByRole('button')
  // A section holding a decision opens itself once it arrives, so a click can land on an already-open one: look again.
  await expect(async () => {
    if ((await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true', { timeout: 1000 })
  }).toPass({ timeout: 10_000 })
}

/** Opens every folded Info section in a panel by clicking its heading toggle (3.27.1). */
export async function openAllInfoSections(scope: Page | Locator) {
  const folded = scope.getByRole('heading').getByRole('button', { expanded: false })
  while ((await folded.count()) > 0) await folded.first().click()
}

/**
 * Hovers a message and clicks a button in its action row. The row shows only while the pointer is over the message, and
 * cards that other specs' approvals and questions put in the shared stream can shift the message away from a pointer that
 * is already resting, so the hover and the click are repeated together until the click lands.
 */
export async function clickAction(message: Locator, name: string | RegExp) {
  await expect(async () => {
    await message.hover()
    await message.getByRole('button', { name }).click({ timeout: 2_000 })
  }).toPass({ timeout: 30_000 })
}

/**
 * A seeded one-to-one's chat id and its newest agent reply, found by title. The one-to-one view merges every chat of the
 * agent, so "the last reply on the page" is whichever chat other specs touched last; a test that acts on a reply names it.
 */
export async function seededReply(page: Page, agent: string, title: string) {
  const direct = (await (await page.request.get(`/api/agents/${agent}/direct`)).json()) as {
    chats: { id: string; roomId: string; title: string }[]
  }
  const chat = direct.chats.find((item) => item.title === title)
  expect(chat, `seeded chat ${title}`).toBeDefined()
  const body = (await (
    await page.request.get(`/api/rooms/${chat!.roomId}/messages?jobId=${chat!.id}`)
  ).json()) as { items: { id: string; author: { kind: string } }[] }
  const replies = body.items.filter((item) => item.author.kind === 'agent')
  expect(replies.length, `a reply in ${title}`).toBeGreaterThan(0)
  const reply = replies[replies.length - 1]!
  return { chatId: chat!.id, replyId: reply.id, reply: messageById(page, reply.id) }
}

/** One message of the conversation, by its id (stable while other chats' messages arrive). */
export const messageById = (page: Page, id: string) =>
  streamOf(page).locator(`[data-message-id="${id}"]`)
