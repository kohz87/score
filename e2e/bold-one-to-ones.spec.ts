import { expect, test, type Page } from '@playwright/test'
import { pair } from './pair.ts'
import { openBoldJob } from './bold-room-fixtures.ts'

// PLAN 11.7: one-to-ones in the bold shell, against the fake adapter's seeded direct chats (builder: "Websockets or
// server-sent events", "The cursor bug", "Working in the Docker sandbox"; reviewer: "How strict to be on docs").
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

async function expectPrivacy(page: Page, agent: string) {
  const label = side(page).locator('[data-protected].bold-dm-privacy')
  await expect(label).toBeVisible()
  await expect(label).toHaveText(`Only you and ${agent} see this`)
}

async function openEarlier(page: Page, agent: string) {
  await side(page).getByRole('button', { name: 'Earlier chats' }).click()
  const dialog = page.getByRole('dialog', { name: `Earlier chats with ${agent}` })
  await expect(dialog).toBeVisible()
  return dialog
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
      await page.goto('/b')
      if (phone) {
        // A phone has no dock (board 19); the side panel's menu lists every agent under "One to one".
        await page.getByRole('button', { name: 'Open side panel' }).click()
        await side(page).getByRole('button', { name: /^Work/ }).click()
        await side(page)
          .getByRole('button', { name: /^builder/ })
          .click()
      } else {
        const ring = page.getByRole('button', { name: /^One to one with builder,/ })
        await expect(ring).toBeVisible()
        await ring.click()
      }
      await expect(page).toHaveURL(/\/b\?with=builder&chat=job_/)
      await expectPrivacy(page, 'builder')
      // It lands in a chat (the newest one; other specs add chats, so which one is not pinned here).
      await expect(side(page).locator('.bold-dm-thread')).toBeVisible()
      // A chat reads oldest first: the seeded websockets chat has the question, then the answer.
      const dialogFirst = await openEarlier(page, 'builder')
      await dialogFirst.getByRole('button', { name: /Websockets or server-sent events/ }).click()
      const thread = side(page).locator('.bold-dm-thread')
      await expect(thread.locator('.bold-dm-message')).toHaveCount(2)
      await expect(thread.locator('.bold-dm-message').first()).toContainText(
        'Why websockets and not server-sent events?',
      )
      await expect(thread.locator('.bold-dm-message').last()).toContainText(
        'Server-sent events only go one way.',
      )
      await expect(side(page).getByPlaceholder('Message builder privately')).toBeVisible()
      // The panel carries the agent's colour (board 19: agent-coloured), and the glyph shows its shape.
      await expect(side(page)).toHaveCSS('--dm-color', /#[0-9a-f]{6}/i)
      await expect(side(page).locator('.bold-dm-privacy')).toHaveAttribute('data-protected', /.+/)
      // The label survives a switch to an earlier chat and to a brand-new one.
      const dialog = await openEarlier(page, 'builder')
      await dialog.getByRole('button', { name: /The cursor bug/ }).click()
      await expect(page).toHaveURL(/chat=job_/)
      await expectPrivacy(page, 'builder')
      await expect(side(page).locator('.bold-dm-message').first()).toContainText(
        'Why did reviewer send the read layer back?',
      )
    })

    test('opens from the Team page Message button', async ({ page }) => {
      await page.goto('/b/team')
      const card = page
        .locator('.bold-agentcard')
        .filter({ has: page.getByRole('link', { name: 'reviewer', exact: true }) })
      await card.getByRole('link', { name: 'Message', exact: true }).click()
      await expect(page).toHaveURL(/\/b\?with=reviewer&chat=job_/)
      await expectPrivacy(page, 'reviewer')
      await expect(side(page).locator('.bold-dm-message').first()).toContainText(
        'How strict should you be on docs?',
      )
    })

    test('opens from Search (a chat result)', async ({ page }) => {
      await page.goto('/b')
      await page.getByRole('button', { name: 'Search', exact: true }).click()
      const search = page.getByRole('combobox', { name: 'Search or run a command' })
      await search.fill('Docker sandbox')
      await page.getByRole('option', { name: /Working in the Docker sandbox/ }).click()
      await expect(page).toHaveURL(/\/b\?with=builder&chat=job_/)
      await expectPrivacy(page, 'builder')
      await expect(side(page).locator('.bold-dm-message').first()).toContainText(
        'Can you work inside the Docker sandbox',
      )
    })

    test('earlier chats list, search and New chat', async ({ page }) => {
      await page.goto('/b?with=builder')
      await expectPrivacy(page, 'builder')
      const dialog = await openEarlier(page, 'builder')
      const rows = dialog.locator('.bold-dm-history-row')
      await expect(rows.filter({ hasText: 'Websockets or server-sent events' })).toHaveCount(1)
      await expect(rows.filter({ hasText: 'The cursor bug' })).toHaveCount(1)
      await expect(rows.filter({ hasText: 'Working in the Docker sandbox' })).toHaveCount(1)
      await expect(rows.filter({ hasText: 'How strict to be on docs' })).toHaveCount(0)

      await dialog.getByRole('textbox', { name: 'Search chats' }).fill('cursor')
      await expect(rows.filter({ hasText: 'The cursor bug' })).toHaveCount(1)
      await expect(rows.filter({ hasText: 'Docker sandbox' })).toHaveCount(0)
      await dialog.getByRole('textbox', { name: 'Search chats' }).fill('zzz-nothing')
      await expect(dialog.getByText('No chats match “zzz-nothing”.')).toBeVisible()
      await dialog.getByRole('textbox', { name: 'Search chats' }).fill('')

      const before = new URL(page.url()).searchParams.get('chat')
      const posts = recordPosts(page)
      await dialog.getByRole('button', { name: 'New chat with builder' }).click()
      await expect.poll(() => posts.length).toBeGreaterThan(0)
      expect(posts[0]).toEqual({ url: '/api/agents/builder/chats', body: {} })
      await expect.poll(() => new URL(page.url()).searchParams.get('chat')).not.toBe(before)
      await expect(side(page).getByRole('heading', { name: 'New chat with builder' })).toBeVisible()
      await expectPrivacy(page, 'builder')
      await expect(dialog).toHaveCount(0)
      // The new chat is now in the list.
      const again = await openEarlier(page, 'builder')
      await expect(again.locator('.bold-dm-history-row.sel')).toHaveCount(1)
      await expect
        .poll(() => again.locator('.bold-dm-history-row').count())
        .toBeGreaterThanOrEqual(4)
    })

    test('"Take it aside" opens an empty one-to-one and makes the chat only when the first message is sent', async ({
      page,
    }) => {
      await page.goto('/b')
      // A phone opens on the job list; the capsule with Take it aside is in the job's own chat.
      if (phone) await openBoldJob(page, /^Activity feed\./)
      const aside = page.getByRole('button', { name: 'Take it aside with builder' }).first()
      await expect(aside).toBeVisible({ timeout: 30_000 })
      const posts = recordPosts(page)
      await aside.click()
      await expect(page).toHaveURL(/\/b\?with=builder&ref=job_[^&]+$/)
      await expectPrivacy(page, 'builder')
      const chip = side(page).locator('.bold-dm-ref')
      await expect(chip).toContainText('Referring to')
      await expect(side(page).getByRole('heading', { name: 'New chat with builder' })).toBeVisible()
      // Looking is free: nothing was created, so Earlier chats has no empty chat in it.
      expect(posts).toHaveLength(0)

      const text = tag('About the review')
      await side(page).getByPlaceholder('Message builder privately').fill(text)
      await side(page).locator('button.chat-send').click()
      await expect(page).toHaveURL(/\/b\?with=builder&chat=job_[^&]+$/)
      await expect(side(page).locator('.bold-dm-message').filter({ hasText: text })).toBeVisible()
      // The message carries a frozen reference to the team-room job, and the chip is spent.
      await expect(side(page).locator('.bold-ref-chip')).toContainText('Referring to')
      await expect(chip).toHaveCount(0)
      const made = posts.filter((post) => post.url === '/api/agents/builder/chats')
      expect(made).toHaveLength(1)
      expect(made[0]?.body).toMatchObject({ title: expect.any(String) })
      const sent = posts.find((post) => /\/api\/rooms\/[^/]+\/messages$/.test(post.url))
      expect(sent?.body).toMatchObject({ text, refs: [{ jobId: expect.stringMatching(/^job_/) }] })
    })

    test('a normal message carries no references, and a draft stays in its own chat', async ({
      page,
    }) => {
      const first = await seededChat(page, 'builder', 'The cursor bug')
      const second = await seededChat(page, 'builder', 'Working in the Docker sandbox')
      await page.goto(`/b?with=builder&chat=${first}`)
      const box = side(page).getByPlaceholder('Message builder privately')
      await box.fill('half a thought for the cursor chat')
      const dialog = await openEarlier(page, 'builder')
      await dialog.getByRole('button', { name: /Docker sandbox/ }).click()
      await expect(page).toHaveURL(new RegExp(`chat=${second}`))
      await expect(side(page).getByPlaceholder('Message builder privately')).toHaveValue('')
      const posts = recordPosts(page)
      const text = tag('No refs')
      await side(page).getByPlaceholder('Message builder privately').fill(text)
      await side(page).locator('button.chat-send').click()
      await expect(side(page).locator('.bold-dm-message').filter({ hasText: text })).toBeVisible()
      const sent = posts.find((post) => /\/api\/rooms\/[^/]+\/messages$/.test(post.url))
      expect(sent?.body).toMatchObject({ text, jobId: second })
      expect(sent?.body).not.toHaveProperty('refs')
      // Back in the first chat the half-written text is still there.
      const again = await openEarlier(page, 'builder')
      await again.getByRole('button', { name: /The cursor bug/ }).click()
      await expect(side(page).getByPlaceholder('Message builder privately')).toHaveValue(
        'half a thought for the cursor chat',
      )
    })

    test('a shared reply appears in the team room labelled "shared from a one-to-one"', async ({
      page,
    }) => {
      const roomId = await teamRoomId(page)
      const jobTitle = tag('Share target')
      const made = await page.request.post(`/api/rooms/${roomId}/jobs`, {
        headers: web,
        data: { title: jobTitle },
      })
      expect(made.status()).toBe(201)
      await page.goto('/b?with=reviewer')
      await expectPrivacy(page, 'reviewer')
      await expect(side(page).locator('.bold-dm-message')).toHaveCount(2)
      const posts = recordPosts(page)
      await side(page).getByRole('button', { name: 'Share to the team room' }).click()
      const menu = page.getByRole('dialog', { name: 'Share to the team room' })
      await expect(menu).toHaveAttribute('data-protected', 'block')
      await menu.getByRole('button', { name: new RegExp(jobTitle) }).click()
      await expect(
        side(page).getByRole('status').filter({ hasText: 'Shared to the team room' }),
      ).toBeVisible()
      const share = posts.find((post) => /\/api\/messages\/[^/]+\/share$/.test(post.url))
      expect(share?.body).toEqual({ jobId: (await made.json()).id })

      // The team room shows a frozen copy, named for the one-to-one it came from.
      await page.goto(`/b?job=${(await made.json()).id}`)
      const shared = page.locator('.bold-shared')
      await expect(shared).toHaveCount(1)
      await expect(shared).toContainText('shared from a one-to-one with you')
      await expect(shared).toContainText('I’ll block only when steps are missing or wrong')
      await expect(shared).toHaveAttribute('data-protected', 'block')
    })

    test('Add someone says what leaves, then moves the talk to the team room with the chat referenced', async ({
      page,
    }) => {
      const chat = await seededChat(page, 'builder', 'Websockets or server-sent events')
      await page.goto(`/b?with=builder&chat=${chat}`)
      await expectPrivacy(page, 'builder')
      await side(page).getByRole('button', { name: 'Add someone' }).click()
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
        page.locator('[data-message-id]').filter({ hasText: '@reviewer Let’s continue this chat' }),
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

    test('Escape, a press outside and focus return work for the popover and the small dialogs', async ({
      page,
    }) => {
      const chat = await seededChat(page, 'builder', 'Websockets or server-sent events')
      await page.goto(`/b?with=builder&chat=${chat}`)
      await expectPrivacy(page, 'builder')

      const earlier = side(page).getByRole('button', { name: 'Earlier chats' })
      const popover = await openEarlier(page, 'builder')
      await page.keyboard.press('Escape')
      await expect(popover).toHaveCount(0)
      await expect(earlier).toBeFocused()
      // Escape closed only the popover: the one-to-one itself is still open.
      await expect(page).toHaveURL(/with=builder/)
      await openEarlier(page, 'builder')
      await side(page)
        .locator('.bold-dm-scroll')
        .click({ position: { x: 5, y: 5 } })
      await expect(page.getByRole('dialog', { name: 'Earlier chats with builder' })).toHaveCount(0)

      const share = side(page).getByRole('button', { name: 'Share to the team room' })
      await share.click()
      await expect(page.getByRole('dialog', { name: 'Share to the team room' })).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(page.getByRole('dialog', { name: 'Share to the team room' })).toHaveCount(0)
      await expect(share).toBeFocused()

      const add = side(page).getByRole('button', { name: 'Add someone' })
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

      if (phone) {
        // With nothing open, Escape on the sheet closes it the way Back does: `?with=` goes.
        await page.keyboard.press('Escape')
        await expect(page).not.toHaveURL(/with=/)
        await expect(page.getByRole('button', { name: 'Open side panel' })).toBeVisible()
      }
    })

    test('the context meter reads the chat’s own session, and the room session for a default thread', async ({
      page,
    }) => {
      const made = await page.request.post('/api/agents/designer/chats', {
        headers: web,
        data: { title: tag('Own session') },
      })
      expect(made.status()).toBe(201)
      const own = (await made.json()) as { id: string; roomId: string }
      const direct = (await (await page.request.get('/api/agents/designer/direct')).json()) as {
        chats: { id: string; isDefault: boolean }[]
      }
      const thread = direct.chats.find((chat) => chat.isDefault)
      expect(thread, 'the direct room’s default thread').toBeDefined()
      const paths: string[] = []
      page.on('request', (request) => {
        const path = new URL(request.url()).pathname
        if (/\/sessions\/[^/]+\/context$/.test(path)) paths.push(decodeURIComponent(path))
      })
      await page.goto(`/b?with=designer&chat=${own.id}`)
      await expect(side(page).getByRole('group', { name: 'Context use' })).toBeVisible()
      await expect
        .poll(() => paths)
        .toContain(`/api/agents/designer/sessions/score-${own.roomId}-${own.id}-designer/context`)
      await page.goto(`/b?with=designer&chat=${thread!.id}`)
      await expect(side(page).getByRole('group', { name: 'Context use' })).toBeVisible()
      await expect
        .poll(() => paths)
        .toContain(`/api/agents/designer/sessions/score-${own.roomId}-designer/context`)
    })

    test('context meter and back to the room', async ({ page }) => {
      const chat = await seededChat(page, 'builder', 'Websockets or server-sent events')
      await page.goto(`/b?with=builder&chat=${chat}`)
      await expectPrivacy(page, 'builder')
      await expect(side(page).getByRole('group', { name: 'Context use' })).toBeVisible()
      await expect(side(page).locator('.bold-dm-context')).toContainText(/\d+%/)
      if (phone) {
        await side(page).getByRole('button', { name: 'Back' }).click()
        await expect(page).not.toHaveURL(/with=/)
        await expect(page.getByRole('button', { name: 'Open side panel' })).toBeVisible()
      }
    })
  })
}
