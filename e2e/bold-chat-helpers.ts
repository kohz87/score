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

/** Waits for the fake agent's reply in a chat and returns its text, so a reading can name its own copy. */
export async function waitForChatReply(page: Page, roomId: string, chatId: string) {
  let reply: string | undefined
  await expect
    .poll(
      async () => {
        const response = await page.request.get(`/api/rooms/${roomId}/messages?jobId=${chatId}`)
        const body = (await response.json()) as {
          items: { author: { kind: string }; parts: { kind: string; text?: string }[] }[]
        }
        reply = body.items
          .filter((item) => item.author.kind === 'agent')
          .flatMap((item) => item.parts)
          .find((part) => part.kind === 'text' && part.text)?.text
        return reply !== undefined
      },
      { timeout: 40_000 },
    )
    .toBe(true)
  return reply!
}

/** Hides direct chats other specs made, so a page reading one agent shows only the chats this test owns. */
export async function onlyDirectChats(page: Page, agent: string, chatIds: readonly string[]) {
  await page.route(
    (url) => url.pathname === `/api/agents/${agent}/direct`,
    async (route) => {
      if (route.request().method() !== 'GET') return route.fallback()
      const response = await route.fetch()
      const body = (await response.json()) as { chats: { id: string }[] }
      await route.fulfill({
        response,
        json: { ...body, chats: body.chats.filter((chat) => chatIds.includes(chat.id)) },
      })
    },
  )
}

/** Keeps the merged direct-chat stream to this test's chats; the server still owns every message and reply. */
export async function onlyChatMessages(page: Page, roomId: string, chatIds: readonly string[]) {
  await page.route(
    (url) =>
      url.pathname === `/api/rooms/${roomId}/messages` && url.searchParams.get('all') === '1',
    async (route) => {
      if (route.request().method() !== 'GET') return route.fallback()
      const response = await route.fetch()
      const body = (await response.json()) as { items: { jobId?: string | null }[] }
      await route.fulfill({
        response,
        json: { ...body, items: body.items.filter((item) => chatIds.includes(item.jobId ?? '')) },
      })
    },
  )
}

/** A fixed seeded chat, found by its title rather than by "the latest" (other specs keep adding chats). */
export async function directChatByTitle(
  page: Page,
  agent: string,
  title: string,
): Promise<DirectChat> {
  const body = (await (await page.request.get(`/api/agents/${agent}/direct`)).json()) as {
    chats: DirectChat[]
  }
  const chat = body.chats.find((item) => item.title === title)
  expect(chat, `seeded chat ${title}`).toBeDefined()
  return chat!
}

export const directComposerOf = (page: Page, agent: string) =>
  page.getByPlaceholder(`Message ${agent} privately`)

export const messagesOf = (page: Page) => streamOf(page).locator('.bold-message')

export async function expectOneToOnePrivacy(page: Page, agent: string) {
  const label = page.locator('[data-protected].bold-dm-privacy')
  await expect(label.first()).toBeVisible()
  await expect(label.first()).toHaveText(`Only you and ${agent} see this`)
}

/** Chat info: open by default on a desktop, a sheet behind the "i" button on a phone. */
export async function openOneToOneInfo(page: Page) {
  const panel = page.getByRole('complementary', { name: 'Side panel' })
  if (!(await panel.isVisible())) await page.getByRole('button', { name: 'Chat info' }).click()
  await expect(panel).toBeVisible()
  const info = panel.getByRole('tab', { name: 'Info' })
  if ((await info.count()) > 0 && (await info.getAttribute('aria-selected')) !== 'true')
    await info.click()
  await openAllInfoSections(panel)
  return panel
}

/** The newest reply's Share action; touch devices show the row without hovering. */
export async function shareReplyAction(page: Page) {
  const share = 'button[aria-label^="Share message from "][aria-label$=" to the team room"]'
  const message = messagesOf(page)
    .filter({ has: page.locator(share) })
    .last()
  await message.hover()
  return message.locator(share)
}

export async function openChatFromInfo(page: Page, title: RegExp) {
  const panel = await openOneToOneInfo(page)
  await panel.getByRole('link', { name: title }).click()
}

export type Posted = { url: string; body: Record<string, unknown> | null }

/** Every mutating request the page makes, with its JSON body, in order. */
export function recordPosts(page: Page): Posted[] {
  const posts: Posted[] = []
  page.on('request', (request) => {
    if (request.method() !== 'POST' || !request.url().includes('/api/')) return
    const data = request.postData()
    posts.push({
      url: new URL(request.url()).pathname,
      body: data ? (JSON.parse(data) as Record<string, unknown>) : null,
    })
  })
  return posts
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
