import { expect, test, type Page } from '@playwright/test'
import { pair } from './pair.ts'
import { clickAction, openAllInfoSections, seededReply } from './bold-chat-helpers.ts'
import { openBoldJob } from './bold-room-fixtures.ts'
import { onlyTeams } from './one-job-helpers.ts'

// PLAN 11.7: one-to-ones in the bold shell, against the fake adapter's seeded direct chats (builder: "Websockets or
// server-sent events", "The cursor bug", "Working in the Docker sandbox"; reviewer: "How strict to be on docs").
test.use({ reducedMotion: 'reduce' })

const sizes = [
  { name: '1440×900', viewport: { width: 1440, height: 900 } },
  { name: '390×844', viewport: { width: 390, height: 844 } },
] as const

function tag(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

// 3.22.0: a one-to-one is the chat view itself (header, one conversation with the agent's chats as topics, composer,
// context bar); the side panel is only Info (the agent, its chats, Add someone) and Results.
const stream = (page: Page) => page.locator('#bold-room-stream')
const messages = (page: Page) => stream(page).locator('.bold-message')
const composerOf = (page: Page, agent: string) =>
  page.getByPlaceholder(`Message ${agent} privately`)

async function expectPrivacy(page: Page, agent: string) {
  const label = page.locator('[data-protected].bold-dm-privacy')
  await expect(label.first()).toBeVisible()
  await expect(label.first()).toHaveText(`Only you and ${agent} see this`)
}

/** Chat info: open by default on a desktop, a sheet behind the "i" button on a phone. Returns the Info panel. */
async function openInfo(page: Page) {
  const panel = page.getByRole('complementary', { name: 'Side panel' })
  if (!(await panel.isVisible())) await page.getByRole('button', { name: 'Chat info' }).click()
  await expect(panel).toBeVisible()
  const info = panel.getByRole('tab', { name: 'Info' })
  if ((await info.count()) > 0 && (await info.getAttribute('aria-selected')) !== 'true')
    await info.click()
  // 3.27.1: the Info sections start folded; a person opens the ones they want.
  await openAllInfoSections(panel)
  return panel
}

/** The share action in a reply's hover row (always shown on touch). */
const SHARE = /^Share message from .* to the team room$/

/** The agent's chats in Info, found by title. Picking one makes it the current topic. */
async function openChatFromInfo(page: Page, title: RegExp) {
  const panel = await openInfo(page)
  await panel.getByRole('link', { name: title }).click()
}

async function teamRoomId(page: Page) {
  await expect
    .poll(async () => (await page.request.get('/api/team-room')).status(), { timeout: 30_000 })
    .toBe(200)
  const team = (await (await page.request.get('/api/team-room')).json()) as {
    room: { id: string }
  }
  return team.room.id
}

type Posted = { url: string; body: Record<string, unknown> | null }

/** Every mutating request the page makes, with its JSON body, in order. */
function recordPosts(page: Page): Posted[] {
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

/** A seeded chat by title: other specs add newer chats, so "the latest" is not a stable thing to open. */
async function seededChat(page: Page, agent: string, title: string) {
  const direct = (await (await page.request.get(`/api/agents/${agent}/direct`)).json()) as {
    chats: { id: string; title: string }[]
  }
  const found = direct.chats.find((chat) => chat.title === title)
  expect(found, `seeded chat ${title}`).toBeDefined()
  return found!.id
}

for (const { name, viewport } of sizes) {
  const phone = viewport.width <= 860

  test.describe(`one-to-ones at ${name}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize(viewport)
      await pair(page)
    })

    test('opens from the dock, lands in the latest chat and always shows the privacy label', async ({
      page,
    }) => {
      // `?open=1` opens the team room's chat; a phone's `/b` is its chat list.
      await page.goto(phone ? '/b' : '/b?open=1')
      if (phone) {
        // A phone has no dock (board 19); its chat list has a Direct group with every agent.
        await page
          .getByRole('complementary', { name: 'Chats', exact: true })
          .getByRole('link', { name: /^builder/ })
          .click()
      } else {
        const ring = page.getByRole('button', { name: /^One to one with builder,/ })
        await expect(ring).toBeVisible()
        await ring.click()
      }
      await expect(page).toHaveURL(/[?&]with=builder/)
      await expectPrivacy(page, 'builder')
      await expect(stream(page)).toBeVisible()
      // The agent's earlier chats are topics of the one conversation, listed in Info: picking one makes it current.
      await openChatFromInfo(page, /Websockets or server-sent events/)
      await expect(page).toHaveURL(/chat=job_/)
      await expect(
        messages(page).filter({ hasText: 'Why websockets and not server-sent events?' }),
      ).toHaveCount(1)
      await expect(
        messages(page).filter({ hasText: 'Server-sent events only go one way.' }),
      ).toHaveCount(1)
      await expect(composerOf(page, 'builder')).toBeVisible()
      // The label survives a switch to another earlier chat.
      await openChatFromInfo(page, /The cursor bug/)
      await expect(page).toHaveURL(/chat=job_/)
      await expectPrivacy(page, 'builder')
      await expect(
        messages(page).filter({ hasText: 'Why did reviewer send the read layer back?' }),
      ).toHaveCount(1)
      await expect(page.locator('.bold-dm-privacy').first()).toHaveAttribute('data-protected', /.+/)
    })

    test('opens from the Team page Message button', async ({ page }) => {
      await page.goto('/b/agents')
      const card = page
        .locator('.bold-agentcard')
        .filter({ has: page.getByRole('link', { name: 'reviewer', exact: true }) })
      await card.getByRole('link', { name: 'Message', exact: true }).click()
      await expect(page).toHaveURL(/[?&]with=reviewer/)
      await expectPrivacy(page, 'reviewer')
      await expect(
        messages(page).filter({ hasText: 'How strict should you be on docs?' }),
      ).toHaveCount(1)
    })

    test('opens from Search (a chat result)', async ({ page }) => {
      await page.goto('/b?open=1')
      await page.getByRole('button', { name: 'Search', exact: true }).click()
      const search = page.getByRole('combobox', { name: 'Search or run a command' })
      await search.fill('Docker sandbox')
      await page.getByRole('option', { name: /Working in the Docker sandbox/ }).click()
      await expect(page).toHaveURL(/\/b\?with=builder&chat=job_/)
      await expectPrivacy(page, 'builder')
      await expect(
        messages(page).filter({ hasText: 'Can you work inside the Docker sandbox' }),
      ).toHaveCount(1)
    })

    test('Info lists the chats, searches them and starts a New chat', async ({ page }) => {
      await page.goto('/b?with=builder')
      await expectPrivacy(page, 'builder')
      const info = await openInfo(page)
      const rows = info.locator('.bold-chat-topics li')
      await expect(rows.filter({ hasText: 'Websockets or server-sent events' })).toHaveCount(1)
      await expect(rows.filter({ hasText: 'The cursor bug' })).toHaveCount(1)
      await expect(rows.filter({ hasText: 'Working in the Docker sandbox' })).toHaveCount(1)
      await expect(rows.filter({ hasText: 'How strict to be on docs' })).toHaveCount(0)

      const search = info.getByRole('searchbox', { name: 'Search chats' })
      await search.fill('cursor')
      await expect(rows.filter({ hasText: 'The cursor bug' })).toHaveCount(1)
      await expect(rows.filter({ hasText: 'Docker sandbox' })).toHaveCount(0)
      await search.fill('zzz-nothing')
      await expect(info.getByText('No chats match “zzz-nothing”.')).toBeVisible()
      await search.fill('')

      const before = new URL(page.url()).searchParams.get('chat')
      const posts = recordPosts(page)
      await info.getByRole('button', { name: 'New chat with builder' }).click()
      await expect.poll(() => posts.length).toBeGreaterThan(0)
      expect(posts[0]).toEqual({ url: '/api/agents/builder/chats', body: {} })
      await expect.poll(() => new URL(page.url()).searchParams.get('chat')).not.toBe(before)
      await expectPrivacy(page, 'builder')
      // The new chat is now in the list, as the current one.
      const again = await openInfo(page)
      await expect(again.locator('.bold-chat-topics a[aria-current="true"]')).toHaveCount(1)
      await expect
        .poll(() => again.locator('.bold-chat-topics li').count())
        .toBeGreaterThanOrEqual(4)
    })

    test('"Take it aside" opens an empty one-to-one and makes the chat only when the first message is sent', async ({
      page,
    }) => {
      await page.goto('/b?open=1')
      // A phone opens on the job list; the capsule with Take it aside is in the job's own chat.
      if (phone) await openBoldJob(page, /^Activity feed\./)
      const aside = page.getByRole('button', { name: 'Take it aside with builder' }).first()
      await expect(aside).toBeVisible({ timeout: 30_000 })
      const posts = recordPosts(page)
      await aside.click()
      await expect(page).toHaveURL(/\/b\?with=builder&ref=job_[^&]+$/)
      await expectPrivacy(page, 'builder')
      const chip = page.locator('.bold-dm-ref')
      await expect(chip).toContainText('Referring to')
      await expect(page.getByRole('heading', { name: 'New chat with builder' })).toBeVisible()
      // Looking is free: nothing was created, so the agent's chats have no empty chat in them.
      expect(posts).toHaveLength(0)

      const text = tag('About the review')
      await composerOf(page, 'builder').fill(text)
      await page.locator('button.chat-send').click()
      await expect(page).toHaveURL(/\/b\?with=builder&chat=job_[^&]+$/)
      await expect(messages(page).filter({ hasText: text })).toBeVisible()
      // The message carries a frozen reference to the team-room job, and the chip is spent.
      await expect(page.locator('.bold-ref-chip').first()).toContainText('Referring to')
      await expect(chip).toHaveCount(0)
      const made = posts.filter((post) => post.url === '/api/agents/builder/chats')
      expect(made).toHaveLength(1)
      expect(made[0]?.body).toMatchObject({ title: expect.any(String) })
      const sent = posts.find((post) => /\/api\/rooms\/[^/]+\/messages$/.test(post.url))
      expect(sent?.body).toMatchObject({ text, refs: [{ jobId: expect.stringMatching(/^job_/) }] })
    })

    test('a normal message carries no references, and a draft follows the one conversation', async ({
      page,
    }) => {
      const first = await seededChat(page, 'builder', 'The cursor bug')
      const second = await seededChat(page, 'builder', 'Working in the Docker sandbox')
      await page.goto(`/b?with=builder&chat=${first}`)
      const box = composerOf(page, 'builder')
      await box.fill('half a thought for the cursor chat')
      await openChatFromInfo(page, /Docker sandbox/)
      await expect(page).toHaveURL(new RegExp(`chat=${second}`))
      // 3.22.0: a chat is one conversation with one composer, so the draft belongs to the conversation and follows
      // the person from topic to topic; what is sent goes to the topic that is current when it is sent.
      await expect(composerOf(page, 'builder')).toHaveValue('half a thought for the cursor chat')
      await composerOf(page, 'builder').fill('')
      const posts = recordPosts(page)
      const text = tag('No refs')
      await composerOf(page, 'builder').fill(text)
      await page.locator('button.chat-send').click()
      await expect(messages(page).filter({ hasText: text })).toBeVisible()
      const sent = posts.find((post) => /\/api\/rooms\/[^/]+\/messages$/.test(post.url))
      expect(sent?.body).toMatchObject({ text, jobId: second })
      expect(sent?.body).not.toHaveProperty('refs')
      // The draft is kept per conversation: switching topics back and forth does not lose it.
      await composerOf(page, 'builder').fill('another half thought')
      await openChatFromInfo(page, /The cursor bug/)
      await expect(composerOf(page, 'builder')).toHaveValue('another half thought')
    })

    test('a shared reply appears in the team room labelled "shared from a one-to-one"', async ({
      page,
    }) => {
      // 3.28.0: the team room already has two active jobs, so a new one is refused (409 job_running); share into the
      // seeded Activity feed job instead.
      // Other specs add teams; with two the share menu is "Share to a team", so this page sees the team room only.
      await onlyTeams(page, [await teamRoomId(page)])
      const jobTitle = 'Activity feed'
      const team = (await (await page.request.get('/api/team-room')).json()) as {
        jobs: { id: string; title: string }[]
      }
      const target = team.jobs.find((item) => item.title === jobTitle)
      expect(target).toBeTruthy()
      const made = { id: target!.id }
      // The seeded chat by title: "the latest reviewer chat" moves when other specs talk to reviewer.
      const seeded = await seededReply(page, 'reviewer', 'How strict to be on docs')
      await page.goto(`/b?with=reviewer&chat=${seeded.chatId}`)
      await expectPrivacy(page, 'reviewer')
      await expect(
        messages(page).filter({ hasText: 'I’ll block only when steps are missing or wrong' }),
      ).toHaveCount(1)
      await expect(seeded.reply).toContainText('I’ll block only when steps are missing or wrong')
      const posts = recordPosts(page)
      await clickAction(seeded.reply, SHARE)
      const menu = page.getByRole('dialog', { name: 'Share to the team room' })
      await expect(menu).toHaveAttribute('data-protected', 'block')
      await menu.getByRole('button', { name: new RegExp(jobTitle) }).click()
      // The confirmation sits in the message's hover row: the menu's job buttons are not under the message, so point at it again.
      await seeded.reply.hover()
      await expect(
        stream(page).getByRole('status').filter({ hasText: 'Shared to the team room' }),
      ).toBeVisible()
      const share = posts.find((post) => /\/api\/messages\/[^/]+\/share$/.test(post.url))
      expect(share?.body).toEqual({ jobId: made.id })

      // The team room shows a frozen copy, named for the one-to-one it came from.
      await page.goto(`/b?job=${made.id}`)
      const shared = page.locator('.bold-shared')
      // 3.22.0: the team room is one merged conversation, so the copies shared to earlier jobs show too.
      await expect(shared.first()).toBeVisible()
      expect(await shared.count()).toBeGreaterThanOrEqual(1)
      const mine = shared
        .filter({ hasText: 'I’ll block only when steps are missing or wrong' })
        .first()
      await expect(mine).toContainText('shared from a one-to-one with you')
      await expect(mine).toHaveAttribute('data-protected', 'block')
      for (const copy of await shared.all())
        await expect(copy).toHaveAttribute('data-protected', 'block')
    })

    test('Add someone says what leaves, then moves the talk to the team room with the chat referenced', async ({
      page,
    }) => {
      await onlyTeams(page, [await teamRoomId(page)])
      const chat = await seededChat(page, 'builder', 'Websockets or server-sent events')
      await page.goto(`/b?with=builder&chat=${chat}`)
      await expectPrivacy(page, 'builder')
      const info = await openInfo(page)
      await info.getByRole('button', { name: 'Add someone' }).click()
      const dialog = page.getByRole('dialog', { name: 'Add someone to this one-to-one' })
      await expect(dialog).toContainText('A one-to-one has no room for a third')
      await expect(dialog).toHaveAttribute('data-protected', 'block')
      await expect(dialog.getByRole('button', { name: 'Add builder' })).toHaveCount(0)
      const posts = recordPosts(page)
      await dialog.getByRole('button', { name: 'Add reviewer' }).click()
      // What leaves is named before it leaves.
      await expect(dialog).toContainText('Websockets or server-sent events')
      await expect(dialog.locator('.bold-dm-add-summary')).toContainText(/summary/i)
      expect(posts).toHaveLength(0)
      await dialog.getByRole('button', { name: 'Add reviewer and share a summary' }).click()
      // The team room opens on the new job; the first message refers to the chat.
      await expect(page).toHaveURL(/\/b\?job=job_/)
      await expect(page).not.toHaveURL(/with=/)
      await expect(
        page
          .locator('[data-message-id]')
          .filter({ hasText: '@reviewer Let’s continue this chat' })
          .first(),
      ).toBeVisible({ timeout: 30_000 })
      await expect(
        page.getByText('Referring to “Websockets or server-sent events”').first(),
      ).toBeVisible()
      const job = posts.find((post) => /\/api\/rooms\/[^/]+\/jobs$/.test(post.url))
      expect(job?.body).toEqual({ title: 'Websockets or server-sent events' })
      const message = posts.find((post) => /\/api\/rooms\/[^/]+\/messages$/.test(post.url))
      expect(message?.body).toMatchObject({
        to: ['builder', 'reviewer'],
        refs: [{ jobId: chat }],
      })
    })

    test('Escape, a press outside and focus return work for the small dialogs', async ({
      page,
    }) => {
      // 3.22.0: the "Earlier chats" popover is gone (the chats are Info's list), so only the dialogs remain.
      await onlyTeams(page, [await teamRoomId(page)])
      const seeded = await seededReply(page, 'builder', 'Websockets or server-sent events')
      await page.goto(`/b?with=builder&chat=${seeded.chatId}`)
      await expectPrivacy(page, 'builder')

      await clickAction(seeded.reply, SHARE)
      const share = seeded.reply.getByRole('button', { name: SHARE })
      await expect(page.getByRole('dialog', { name: 'Share to the team room' })).toBeVisible()
      // The row's buttons show only while the message is hovered; opening the menu can move the message under or away
      // from the pointer, so rest the pointer on it again before Escape.
      await seeded.reply.hover()
      await page.keyboard.press('Escape')
      await expect(page.getByRole('dialog', { name: 'Share to the team room' })).toHaveCount(0)
      await expect(share).toBeFocused()

      const info = await openInfo(page)
      const add = info.getByRole('button', { name: 'Add someone' })
      await add.click()
      await expect(
        page.getByRole('dialog', { name: 'Add someone to this one-to-one' }),
      ).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(
        page.getByRole('dialog', { name: 'Add someone to this one-to-one' }),
      ).toHaveCount(0)
      await expect(add).toBeFocused()
      await expect(page).toHaveURL(/with=builder/)
    })

    test('the context bar names who it goes to and the topic, and back leads to the chat list', async ({
      page,
    }) => {
      // 3.22.0: the per-chat context ring under the composer is replaced by the context bar (agent-level reading).
      const chat = await seededChat(page, 'builder', 'Websockets or server-sent events')
      await page.goto(`/b?with=builder&chat=${chat}`)
      await expectPrivacy(page, 'builder')
      const bar = page.getByLabel('Where this message goes')
      await expect(bar).toContainText('builder')
      await expect(bar).toContainText('Websockets or server-sent events')
      if (phone) {
        await page.getByRole('button', { name: 'Back to chats' }).click()
        await expect(page).not.toHaveURL(/with=/)
        await expect(page.getByRole('complementary', { name: 'Chats', exact: true })).toBeVisible()
      }
    })
  })
}
