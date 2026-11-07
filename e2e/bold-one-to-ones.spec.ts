import { expect, test } from '@playwright/test'
import { pair } from './pair.ts'
import {
  directChatByTitle,
  directComposerOf,
  expectOneToOnePrivacy,
  makeDirectChat,
  messagesOf,
  openChatFromInfo,
  openOneToOneInfo,
  onlyChatMessages,
  onlyDirectChats,
  recordPosts,
  shareReplyAction,
  streamOf,
  waitForChatReply,
} from './bold-chat-helpers.ts'
import { mockBoldRoom } from './bold-room-fixtures.ts'
import { makeJob, makeTeam, pinTeamRoom } from './one-job-helpers.ts'

// PLAN 11.7: seeded chats move as other specs write, and the shared team room accumulates jobs; each test owns its chats and team.
test.use({ reducedMotion: 'reduce' })

const sizes = [
  { name: '1440×900', viewport: { width: 1440, height: 900 } },
  { name: '390×844', viewport: { width: 390, height: 844 } },
] as const

function tag(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

const stream = streamOf
const messages = messagesOf
const composerOf = directComposerOf
const expectPrivacy = expectOneToOnePrivacy
const openInfo = openOneToOneInfo
const shareAction = shareReplyAction

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
      // The seeded direct chats are shared and "latest" moves as other specs write; make three chats and hide theirs.
      const stamp = tag('dock')
      const wsTitle = `Websockets or server-sent events ${stamp}`
      const wsQuestion = `Why websockets and not server-sent events? ${stamp}`
      const ws = await makeDirectChat(page, 'builder', wsTitle, wsQuestion)
      const wsReply = await waitForChatReply(page, ws.roomId, ws.id)
      const cursorTitle = `The cursor bug ${stamp}`
      const cursorQuestion = `Why did reviewer send the read layer back? ${stamp}`
      const cursor = await makeDirectChat(page, 'builder', cursorTitle, cursorQuestion)
      await waitForChatReply(page, cursor.roomId, cursor.id)
      await new Promise((resolve) => setTimeout(resolve, 20))
      const latest = await makeDirectChat(page, 'builder', `Latest chat ${stamp}`)
      const own = [ws.id, cursor.id, latest.id]
      await onlyDirectChats(page, 'builder', own)
      await onlyChatMessages(page, ws.roomId, own)
      await page.goto(phone ? '/b' : '/b?open=1')
      if (phone) {
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
      await expect(page).toHaveURL(new RegExp(`chat=${latest.id}`))
      await expectPrivacy(page, 'builder')
      await expect(stream(page)).toBeVisible()
      // The agent's earlier chats are topics of the one conversation, listed in Info: picking one makes it current.
      await openChatFromInfo(page, new RegExp(wsTitle))
      await expect(page).toHaveURL(new RegExp(`chat=${ws.id}`))
      await expect(messages(page).filter({ hasText: wsQuestion })).toHaveCount(1)
      await expect(messages(page).filter({ hasText: wsReply })).toHaveCount(1)
      await expect(composerOf(page, 'builder')).toBeVisible()
      await openChatFromInfo(page, new RegExp(cursorTitle))
      await expect(page).toHaveURL(new RegExp(`chat=${cursor.id}`))
      await expectPrivacy(page, 'builder')
      await expect(messages(page).filter({ hasText: cursorQuestion })).toHaveCount(1)
      await expect(page.locator('.bold-dm-privacy').first()).toHaveAttribute('data-protected', /.+/)
    })

    test('opens from the Team page Message button', async ({ page }) => {
      // The Message button opens the agent's newest chat, which other specs move; return only this test's chat.
      const stamp = tag('team')
      const question = `How strict should you be on docs? ${stamp}`
      const chat = await makeDirectChat(page, 'reviewer', `Docs policy ${stamp}`, question)
      await waitForChatReply(page, chat.roomId, chat.id)
      await onlyDirectChats(page, 'reviewer', [chat.id])
      await onlyChatMessages(page, chat.roomId, [chat.id])
      await page.goto('/b/agents')
      const card = page
        .locator('.bold-agentcard')
        .filter({ has: page.getByRole('link', { name: 'reviewer', exact: true }) })
      await card.getByRole('link', { name: 'Message', exact: true }).click()
      await expect(page).toHaveURL(/[?&]with=reviewer/)
      await expect(page).toHaveURL(new RegExp(`chat=${chat.id}`))
      await expectPrivacy(page, 'reviewer')
      await expect(messages(page).filter({ hasText: question })).toHaveCount(1)
    })

    test('opens from Search (a chat result)', async ({ page }) => {
      // Search reads every direct chat on the shared server; a unique title names the one result without racing them.
      const stamp = tag('search')
      const title = `Working in the Docker sandbox ${stamp}`
      const question = `Can you work inside the Docker sandbox? ${stamp}`
      const chat = await makeDirectChat(page, 'builder', title, question)
      await page.goto(`/b?with=builder&chat=${chat.id}`)
      await expectPrivacy(page, 'builder')
      await page.goto('/b?open=1')
      await page.getByRole('button', { name: 'Search', exact: true }).click()
      const search = page.getByRole('combobox', { name: 'Search or run a command' })
      await search.fill(title)
      await page.getByRole('option', { name: new RegExp(title) }).click()
      await expect(page).toHaveURL(new RegExp(`/b\\?with=builder&chat=${chat.id}`))
      await expectPrivacy(page, 'builder')
      await expect(messages(page).filter({ hasText: question })).toHaveCount(1)
    })

    test('Info lists the chats, searches them and starts a New chat', async ({ page }) => {
      // The live chat list is shared and only grows; make the three topics this test reads, with unique words.
      const stamp = tag('info')
      const websockets = await makeDirectChat(
        page,
        'builder',
        `Websockets or server-sent events ${stamp}`,
      )
      const cursor = await makeDirectChat(page, 'builder', `The cursor bug ${stamp}`)
      const docker = await makeDirectChat(page, 'builder', `Working in the Docker sandbox ${stamp}`)
      await page.goto(`/b?with=builder&chat=${websockets.id}`)
      await expectPrivacy(page, 'builder')
      const info = await openInfo(page)
      const rows = info.locator('.bold-chat-topics li')
      await expect(rows.filter({ hasText: websockets.title })).toHaveCount(1)
      await expect(rows.filter({ hasText: cursor.title })).toHaveCount(1)
      await expect(rows.filter({ hasText: docker.title })).toHaveCount(1)
      await expect(rows.filter({ hasText: 'How strict to be on docs' })).toHaveCount(0)

      const search = info.getByRole('searchbox', { name: 'Search chats' })
      await search.fill(cursor.title)
      await expect(rows.filter({ hasText: cursor.title })).toHaveCount(1)
      await expect(rows.filter({ hasText: 'Docker sandbox' })).toHaveCount(0)
      const nothing = `zzz-nothing-${stamp}`
      await search.fill(nothing)
      await expect(info.getByText(`No chats match “${nothing}”.`)).toBeVisible()
      await search.fill('')

      const before = new URL(page.url()).searchParams.get('chat')
      const posts = recordPosts(page)
      await info.getByRole('button', { name: 'New chat with builder' }).click()
      await expect.poll(() => posts.length).toBeGreaterThan(0)
      expect(posts[0]).toEqual({ url: '/api/agents/builder/chats', body: {} })
      await expect.poll(() => new URL(page.url()).searchParams.get('chat')).not.toBe(before)
      await expectPrivacy(page, 'builder')
      const again = await openInfo(page)
      await expect(again.locator('.bold-chat-topics a[aria-current="true"]')).toHaveCount(1)
      await expect
        .poll(() => again.locator('.bold-chat-topics li').count())
        .toBeGreaterThanOrEqual(4)
    })

    test('"Take it aside" opens an empty one-to-one and makes the chat only when the first message is sent', async ({
      page,
    }) => {
      // The team room's jobs and exchanges are shared; this fixture job and exchange belong to the test alone.
      const job = {
        id: 'job_aside',
        roomId: 'team-room',
        title: 'Take it aside study',
        state: 'working',
        holderAgentId: 'builder',
        isDefault: false,
        exchangeBudget: 8,
        jobTurnLimit: 40,
        unread: 0,
        activeAgents: [],
        lastMessageAt: null,
        messageCount: 0,
        summary: null,
        source: null,
        reportBack: null,
        spendCapUsd: null,
        recipe: null,
        createdAt: '2026-10-24T10:00:00.000Z',
        updatedAt: '2026-10-24T10:15:00.000Z',
      }
      const exchange = {
        id: 'exchange-aside',
        jobId: job.id,
        roomId: 'team-room',
        kind: 'review',
        parentId: null,
        from: 'builder',
        to: 'lead',
        state: 'live',
        round: 1,
        turnsUsed: 1,
        budget: 8,
        outcome: null,
        endedReason: null,
        pause: null,
        queuedBehind: null,
        createdAt: '2026-10-24T10:01:00.000Z',
        updatedAt: '2026-10-24T10:02:00.000Z',
      }
      await mockBoldRoom(page, {
        jobs: [job],
        handle: (request) =>
          request.method === 'GET' && request.path === `/api/jobs/${job.id}/exchanges`
            ? { body: { asOfSeq: 12, items: [exchange] } }
            : undefined,
      })
      await page.goto(`/b?open=1&job=${job.id}`)
      const aside = page.getByRole('button', { name: 'Take it aside with builder' }).first()
      await expect(aside).toBeVisible({ timeout: 30_000 })
      const posts = recordPosts(page)
      await aside.click()
      await expect(page).toHaveURL(/\/b\?with=builder&ref=job_[^&]+$/)
      await expectPrivacy(page, 'builder')
      const chip = page.locator('.bold-dm-ref')
      await expect(chip).toContainText('Referring to')
      await expect(page.getByRole('heading', { name: 'New chat with builder' })).toBeVisible()
      expect(posts).toHaveLength(0)

      const text = tag('About the review')
      await composerOf(page, 'builder').fill(text)
      await page.locator('button.chat-send').click()
      await expect(page).toHaveURL(/\/b\?with=builder&chat=job_[^&]+$/)
      await expect(messages(page).filter({ hasText: text })).toBeVisible()
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
      // Two owned topics: the seeded ones are shared and other specs write into them while this draft moves.
      const stamp = tag('draft')
      const first = await makeDirectChat(
        page,
        'builder',
        `The cursor bug ${stamp}`,
        `Cursor question ${stamp}`,
      )
      const second = await makeDirectChat(
        page,
        'builder',
        `Working in the Docker sandbox ${stamp}`,
        `Docker question ${stamp}`,
      )
      await onlyDirectChats(page, 'builder', [first.id, second.id])
      await onlyChatMessages(page, first.roomId, [first.id, second.id])
      await page.goto(`/b?with=builder&chat=${first.id}`)
      const box = composerOf(page, 'builder')
      await box.fill('half a thought for the cursor chat')
      await openChatFromInfo(page, new RegExp(second.title))
      await expect(page).toHaveURL(new RegExp(`chat=${second.id}`))
      // One composer follows the person across topics; what is sent goes to the current one (3.22.0).
      await expect(composerOf(page, 'builder')).toHaveValue('half a thought for the cursor chat')
      await composerOf(page, 'builder').fill('')
      const posts = recordPosts(page)
      const text = tag('No refs')
      await composerOf(page, 'builder').fill(text)
      await page.locator('button.chat-send').click()
      await expect(messages(page).filter({ hasText: text })).toBeVisible()
      const sent = posts.find((post) => /\/api\/rooms\/[^/]+\/messages$/.test(post.url))
      expect(sent?.body).toMatchObject({ text, jobId: second.id })
      expect(sent?.body).not.toHaveProperty('refs')
      // The draft is kept per conversation: switching topics back and forth does not lose it.
      await composerOf(page, 'builder').fill('another half thought')
      await openChatFromInfo(page, new RegExp(first.title))
      await expect(composerOf(page, 'builder')).toHaveValue('another half thought')
    })

    test('a shared reply appears in the team room labelled "shared from a one-to-one"', async ({
      page,
    }) => {
      // The seeded docs chat is fixed; the destination team, job and merged history are this test's own.
      const source = await directChatByTitle(page, 'reviewer', 'How strict to be on docs')
      await onlyChatMessages(page, source.roomId, [source.id])
      const team = await makeTeam(page, 'shared reply')
      const job = await makeJob(page, team.id, `Shared reply ${tag('job')}`)
      await pinTeamRoom(page, team, [job])
      await page.goto(`/b?with=reviewer&chat=${source.id}`)
      await expectPrivacy(page, 'reviewer')
      await expect(
        messages(page).filter({ hasText: 'I’ll block only when steps are missing or wrong' }),
      ).toHaveCount(1)
      const posts = recordPosts(page)
      await (await shareAction(page)).click()
      const menu = page.getByRole('dialog', { name: 'Share to the team room' })
      await expect(menu).toHaveAttribute('data-protected', 'block')
      await menu.getByRole('button', { name: new RegExp(job.title) }).click()
      // The confirmation sits in the message's hover row: the menu's job buttons are not under the message, so point at it again.
      await messages(page)
        .filter({ hasText: 'I’ll block only when steps are missing or wrong' })
        .hover()
      await expect(
        stream(page).getByRole('status').filter({ hasText: 'Shared to the team room' }),
      ).toBeVisible()
      const share = posts.find((post) => /\/api\/messages\/[^/]+\/share$/.test(post.url))
      expect(share?.body).toEqual({ jobId: job.id })

      // The team room shows a frozen copy, named for the one-to-one it came from.
      await page.goto(`/b?job=${job.id}`)
      const shared = page.locator('.bold-shared')
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
      // The hand-off names and refs this chat, and starts in a team made for the test rather than the shared team room.
      const chat = await makeDirectChat(
        page,
        'builder',
        'Websockets or server-sent events',
        `Add someone ${tag('question')}`,
      )
      await onlyChatMessages(page, chat.roomId, [chat.id])
      const team = await makeTeam(page, 'add someone')
      await pinTeamRoom(page, team)
      await page.goto(`/b?with=builder&chat=${chat.id}`)
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
        refs: [{ jobId: chat.id }],
      })
    })

    test('Escape, a press outside and focus return work for the small dialogs', async ({
      page,
    }) => {
      // 3.22.0: the "Earlier chats" popover is gone (the chats are Info's list), so only the dialogs remain.
      const chat = await makeDirectChat(
        page,
        'builder',
        'Websockets or server-sent events',
        `Escape ${tag('question')}`,
      )
      await waitForChatReply(page, chat.roomId, chat.id)
      await onlyChatMessages(page, chat.roomId, [chat.id])
      // One pinned team keeps the chooser from naming another spec's team ("Share to a team").
      await pinTeamRoom(page, await makeTeam(page, 'escape'))
      await page.goto(`/b?with=builder&chat=${chat.id}`)
      await expectPrivacy(page, 'builder')

      const share = await shareAction(page)
      await share.click()
      await expect(page.getByRole('dialog', { name: 'Share to the team room' })).toBeVisible()
      // The row's buttons show only while the message is hovered; opening the menu can move the message under or away
      // from the pointer, so rest the pointer on it again before Escape.
      await shareAction(page)
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
      const chat = await makeDirectChat(
        page,
        'builder',
        'Websockets or server-sent events',
        `Context ${tag('question')}`,
      )
      await page.goto(`/b?with=builder&chat=${chat.id}`)
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
