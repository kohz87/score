import { expect, test, type Page } from '@playwright/test'
import { mockBoldRoom, openBoldJob } from './bold-room-fixtures.ts'
import { pair } from './pair.ts'

// PLAN 11.4c, moved in 3.22.0: the thread panel is gone. Its parts live in Info › This topic (status, rounds and turns,
// Stop, run card, report-back, tasks), on the needs-you card (a paused exchange, step in) and in the chat itself. The seeded fake room moves over time, so the contract-shaped
// reads are pinned to fixtures (as in bold-room.spec.ts); the shell, pairing and request validation stay real.
test.use({ reducedMotion: 'reduce' })

const sizes = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
] as const

const at = (minute: number) => `2026-10-24T10:${String(minute).padStart(2, '0')}:00.000Z`

function message(id: string, minute: number, author: unknown, parts: unknown[]) {
  return {
    id,
    roomId: 'team-room',
    jobId: 'job-activity',
    author,
    to: [],
    parts,
    createdAt: at(minute),
    streaming: false,
    refs: [],
  }
}

const activityMessages = [
  message('t-1', 3, { kind: 'you' }, [{ kind: 'text', text: 'Build the activity feed.' }]),
  message('t-2', 4, { kind: 'agent', agentId: 'builder' }, [
    { kind: 'text', text: 'First cut is ready for review.' },
  ]),
  message('t-3', 5, { kind: 'agent', agentId: 'reviewer' }, [
    { kind: 'text', text: 'The cursor jumps on refresh.' },
    { kind: 'review', verdict: 'changes_requested', taskId: null },
  ]),
  message('t-4', 6, { kind: 'agent', agentId: 'builder' }, [
    { kind: 'text', text: 'Cursor is stable now.' },
  ]),
  message('t-5', 7, { kind: 'agent', agentId: 'reviewer' }, [
    { kind: 'text', text: 'Looks right to me.' },
    { kind: 'review', verdict: 'approved', taskId: null },
  ]),
]

const liveExchange = {
  id: 'exchange-activity',
  jobId: 'job-activity',
  roomId: 'team-room',
  kind: 'review',
  parentId: null,
  from: 'builder',
  to: 'reviewer',
  state: 'live',
  round: 2,
  turnsUsed: 5,
  budget: 8,
  outcome: null,
  endedReason: null,
  pause: null,
  queuedBehind: null,
  createdAt: at(4),
  updatedAt: at(7),
}

const sessionId = 'score-team-room-job-activity-builder'

async function openThread(
  page: Page,
  options: {
    exchange?: Record<string, unknown>
    tasks?: Record<string, unknown>[]
    reportBack?: Record<string, unknown> | null
    handle?: (path: string, method: string) => { body: unknown; status?: number } | undefined
  } = {},
) {
  await pair(page)
  const state = await mockBoldRoom(page, {
    ...(options.exchange ? { exchange: options.exchange } : {}),
    ...(options.reportBack !== undefined ? { reportBack: options.reportBack } : {}),
  })
  const posts: { path: string; body: unknown }[] = []
  // Registered after the shared fixture, so these answers win for the job under test.
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    if (request.method() === 'GET' && path === '/api/rooms/team-room/messages') {
      // 3.22.0: the chat reads every topic in one list; this fixture's thread messages are the Activity feed's.
      if (url.searchParams.get('all') === '1')
        return json({
          asOfSeq: 12,
          items: [...activityMessages].reverse(),
          nextCursor: null,
          jobId: null,
        })
      if (url.searchParams.get('jobId') === 'job-activity')
        return json({
          asOfSeq: 12,
          items: activityMessages,
          nextCursor: null,
          jobId: 'job-activity',
        })
    }
    if (request.method() === 'GET' && path === '/api/jobs/job-activity/exchanges')
      return json({ asOfSeq: 12, items: [liveExchange] })
    if (request.method() === 'GET' && path === `/api/agents/builder/sessions/${sessionId}/context`)
      return json({
        asOfSeq: 12,
        window: 100000,
        used: 42000,
        measuredAt: at(7),
        model: 'demo-model',
        source: 'provider_usage',
        parts: null,
        autoCompactAt: null,
        compactions: 0,
      })
    if (request.method() === 'GET' && path === '/api/tasks')
      return json({
        asOfSeq: 12,
        columns: {
          planned: [],
          working: options.tasks ?? [],
          in_review: [],
          needs_you: [],
          done: [],
        },
      })
    if (request.method() === 'GET' && path.startsWith('/api/tasks/'))
      return json({
        ...options.tasks?.[0],
        body: 'The login timeout needs a decision.',
        createdBy: 'you',
        steps: [
          { id: 'step-1', text: 'Reproduce the timeout', done: true },
          { id: 'step-2', text: 'Pick the new limit', done: false },
        ],
        activity: [],
        pendingApproval: null,
        dependsOn: [],
        blocks: [],
        runIds: [],
      })
    if (request.method() === 'POST') {
      let body: unknown
      try {
        body = JSON.parse(request.postData() ?? 'null')
      } catch {
        body = null
      }
      if (path === `/api/agents/builder/sessions/${sessionId}/compact`) {
        posts.push({ path, body })
        return json({ commandId: 'cmd-1' }, 202)
      }
      if (path === '/api/jobs/job-activity/end') {
        posts.push({ path, body })
        return json({ ok: true })
      }
      if (path === '/api/tasks/task-thread/actions') {
        posts.push({ path, body })
        return json({ taskId: 'task-thread', action: 'comment', ok: true })
      }
      if (path === '/api/jobs/job-activity/report-back') {
        posts.push({ path, body })
        return json({ ok: true })
      }
    }
    // The decision POST comes back without the exchange leaving its pause (as bold-room.spec.ts does).
    if (request.method() === 'POST' && /^\/api\/exchanges\/[^/]+\/decision$/.test(path)) {
      posts.push({ path, body: JSON.parse(request.postData() ?? 'null') })
      return json({ ok: true })
    }
    const handled = options.handle?.(path, request.method())
    if (handled) return json(handled.body, handled.status)
    return route.fallback()
  })
  await page.goto('/b?open=1')
  await expect(page.locator('[data-ui="bold"] .top .word')).toBeVisible({ timeout: 20_000 })
  return { ...state, posts }
}

/** Makes the topic current and returns Info's "This topic" section (on a phone Info is the Chat info sheet). */
async function openTopicInfo(page: Page, title: RegExp, only = false) {
  // 3.28.0: a chat with one active job has no list to pick from; that job is the current one and Info shows This job.
  if (!only) await openBoldJob(page, title)
  if ((page.viewportSize()?.width ?? 1440) <= 860)
    await page.getByRole('button', { name: 'Chat info' }).click()
  const section = page.locator('.bold-topic-info')
  await expect(section).toBeVisible()
  return section
}

const recipeRoom = {
  id: 'team-room',
  name: 'Team room',
  kind: 'room',
  leadAgentId: 'lead',
  members: ['lead', 'builder', 'reviewer', 'designer'],
  unread: 0,
  activeAgents: [],
  channels: [],
  role: 'team',
  routing: 'exchanges',
}

function recipeJob(id: string, title: string, isDefault: boolean, recipe: unknown) {
  return {
    id,
    roomId: 'team-room',
    title,
    state: 'working',
    holderAgentId: 'lead',
    isDefault,
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
    recipe,
    createdAt: at(0),
    updatedAt: at(8),
  }
}

const orchestration = {
  id: 'orch-activity',
  title: 'Activity feed plan',
  status: 'running',
  pauseReason: null,
  leadAgentId: 'lead',
  roomId: 'team-room',
  briefId: 'brief-activity',
  gatePolicy: 'lead-asks',
  revision: 1,
  ownership: 'owned',
  steps: { total: 4, active: 1, succeeded: 2, failed: 0 },
  leadTurnsUsed: 1,
  maxLeadTurns: 8,
  needsYou: [],
  createdAt: at(1),
  updatedAt: at(8),
  endedAt: null,
}

function budgetPause(turnsUsed: number, reason: 'exchange_budget' | 'job_limit') {
  return {
    id: 'exchange-notes',
    jobId: 'job-notes',
    roomId: 'team-room',
    kind: 'ask',
    parentId: null,
    from: 'lead',
    to: 'reviewer',
    state: 'paused_budget',
    round: 1,
    turnsUsed,
    budget: 8,
    outcome: null,
    endedReason: null,
    pause: {
      reason,
      options: reason === 'job_limit' ? ['more_turns', 'stop'] : ['more_turns', 'step_in', 'stop'],
    },
    queuedBehind: null,
    createdAt: at(8),
    updatedAt: at(9),
  }
}

for (const viewport of sizes) {
  const size = `${viewport.width}×${viewport.height}`
  test.describe(size, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize(viewport)
    })

    test(`a live topic shows its status, turns and Stop in Info at ${size}`, async ({ page }) => {
      const state = await openThread(page)
      const topic = await openTopicInfo(page, /Activity feed/)

      await expect(topic.getByText('Activity feed', { exact: true }).first()).toBeVisible()
      await expect(topic.locator('.bold-topic-status')).toContainText('5 of 8 turns used')
      // No exchange waits on the person, so no needs-you pill shows.
      await expect(topic.locator('.bold-topic-status [data-protected]')).toHaveCount(0)
      // The topic's messages are in the one conversation (the rounds headings of the old panel are gone).
      await expect(page.getByText('The cursor jumps on refresh.')).toBeVisible()
      await expect(page.getByText('Cursor is stable now.')).toBeVisible()

      // Stop asks first, and the confirmation is a protected surface.
      await topic.getByRole('button', { name: 'Stop job', exact: true }).click()
      const confirm = page.getByRole('alertdialog', { name: 'Stop Activity feed?' })
      await expect(confirm).toHaveAttribute('data-protected', 'block')
      await confirm.getByRole('button', { name: 'Keep going' }).click()
      await expect(confirm).toHaveCount(0)
      expect(state.posts.some((item) => item.path === '/api/jobs/job-activity/end')).toBe(false)
      await topic.getByRole('button', { name: 'Stop job', exact: true }).click()
      await page.getByRole('alertdialog').getByRole('button', { name: 'Stop job' }).click()
      await expect(page.getByRole('status').filter({ hasText: 'Stopped.' })).toBeVisible()
      expect(state.posts.filter((item) => item.path === '/api/jobs/job-activity/end')).toHaveLength(
        1,
      )

      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        viewport.width,
      )
    })

    test(`a topic's messages have the action row and delete works at ${size}`, async ({ page }) => {
      const deletes: string[] = []
      await openThread(page, {
        handle: (path, method) => {
          if (method === 'DELETE' && path.startsWith('/api/rooms/team-room/messages/')) {
            deletes.push(path)
            return { body: null, status: 204 }
          }
          return undefined
        },
      })
      await openBoldJob(page, /Activity feed/)
      const own = page.locator('[data-message-id="t-1"]')
      await own.hover()
      await expect(own.getByRole('button', { name: 'Edit message from You' })).toBeVisible()
      await expect(own.getByRole('button', { name: 'Copy message from You' })).toBeVisible()
      await expect(own.getByRole('button', { name: 'Pin message from You' })).toBeVisible()
      const reply = page.locator('[data-message-id="t-2"]')
      await reply.hover()
      await expect(
        reply.getByRole('button', { name: 'Try another reply from builder' }),
      ).toBeVisible()
      // A later agent message in the same run of replies answers the person too.
      const later = page.locator('[data-message-id="t-4"]')
      await later.hover()
      await expect(later.getByRole('button', { name: /^Try another reply/ })).toHaveCount(1)

      // An agent's message goes at once (undo window), then the DELETE is sent.
      await reply.hover()
      await reply.getByRole('button', { name: 'Delete message from builder' }).click()
      await expect(page.getByText('First cut is ready for review.')).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'Undo' })).toBeVisible()
      await expect
        .poll(() => deletes, { timeout: 15_000 })
        .toEqual(['/api/rooms/team-room/messages/t-2'])
      await own.hover()
      await own.getByRole('button', { name: 'Edit message from You' }).click()
      await expect(page.locator('.bold-room-composer textarea')).toBeFocused()
      await expect(page.getByText('Editing your message')).toBeVisible()
    })

    test(`a paused exchange is answered from its needs-you card at ${size}`, async ({ page }) => {
      const state = await openThread(page)
      const topic = await openTopicInfo(page, /Release notes 2\.4/)
      // The pause is also named in Info: the protected Needs you pill.
      await expect(topic.locator('.bold-topic-status [data-protected]')).toBeVisible()
      if (viewport.width <= 860)
        await page.getByRole('button', { name: 'Close side panel' }).click()

      const card = page.getByRole('article', { name: /The review ended without a verdict/ })
      await expect(card).toHaveAttribute('data-protected', 'flex')
      await card.scrollIntoViewIfNeeded()
      await expect(card).toContainText('8 of 8')
      await card.getByRole('button', { name: /Send back/ }).click()
      await card.getByLabel('Note for the author').fill('Tighten the migration steps.')
      await card
        .getByRole('button', { name: /Send back/ })
        .last()
        .click()
      await expect(card).toContainText('Sent back with your note.')
      expect(
        state.posts.some(
          (item) =>
            item.path === '/api/exchanges/exchange-notes/decision' &&
            JSON.stringify(item.body) ===
              JSON.stringify({ option: 'send_back', note: 'Tighten the migration steps.' }),
        ),
      ).toBe(true)
    })

    test(`the card's Step in answers a budget pause with step_in at ${size}`, async ({ page }) => {
      const state = await openThread(page, { exchange: budgetPause(8, 'exchange_budget') })
      const topic = await openTopicInfo(page, /Release notes 2\.4/)
      await expect(topic.locator('.bold-topic-status')).toContainText('8 of 8 turns used')
      if (viewport.width <= 860)
        await page.getByRole('button', { name: 'Close side panel' }).click()
      const card = page.getByRole('article', { name: /The exchange used its turns/ })
      await card.scrollIntoViewIfNeeded()
      await card.getByRole('button', { name: 'Step in', exact: true }).click()
      await card.getByLabel('What should happen next?').fill('Go on with the short version.')
      await card.getByRole('button', { name: 'Step in', exact: true }).click()
      await expect(card.getByRole('status')).toContainText('Decision sent.')
      expect(
        state.posts.some(
          (item) =>
            item.path === '/api/exchanges/exchange-notes/decision' &&
            JSON.stringify(item.body) ===
              JSON.stringify({ option: 'step_in', text: 'Go on with the short version.' }),
        ),
      ).toBe(true)
    })

    test(`a topic with a recipe shows its run card with the step count at ${size}`, async ({
      page,
    }) => {
      await pair(page)
      await mockBoldRoom(page)
      const recipeJobs = [
        recipeJob('job-default', 'Team room', true, null),
        recipeJob('job-plan', 'Activity feed plan', false, {
          kind: 'orchestration',
          ref: 'orch-activity',
        }),
      ]
      await page.route('**/api/**', async (route) => {
        const url = new URL(route.request().url())
        const path = url.pathname
        const json = (body: unknown) =>
          route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(body),
          })
        if (route.request().method() !== 'GET') return route.fallback()
        if (path === '/api/team-room')
          return json({ asOfSeq: 12, room: recipeRoom, jobs: recipeJobs })
        if (path === '/api/rooms/team-room/jobs') return json({ asOfSeq: 12, items: recipeJobs })
        if (path === '/api/orchestrations') return json({ asOfSeq: 12, items: [orchestration] })
        if (/^\/api\/jobs\/[^/]+\/exchanges$/.test(path)) return json({ asOfSeq: 12, items: [] })
        if (path === '/api/rooms/team-room/messages')
          return json({
            asOfSeq: 12,
            items: [],
            nextCursor: null,
            jobId: url.searchParams.get('all') === '1' ? null : 'job-plan',
          })
        return route.fallback()
      })
      await page.goto('/b?open=1')
      await expect(page.locator('[data-ui="bold"] .top .word')).toBeVisible({ timeout: 20_000 })
      const info = await openTopicInfo(page, /Activity feed plan/, true)
      await expect(info).toContainText('Activity feed plan')
      const card = page.getByRole('region', { name: 'Recipe run' })
      await expect(card).toContainText('Orchestration')
      await expect(card).toContainText('Activity feed plan')
      await expect(card).toContainText('2 of 4 steps done')
      await expect(card.getByRole('link', { name: 'Open the run' })).toHaveAttribute(
        'href',
        /\/b\/settings\/recipes\?run=brief-activity$/,
      )
    })

    test(`Info shows report-back, sends it, and lists Hermes tasks at ${size}`, async ({
      page,
    }) => {
      const state = await openThread(page, {
        reportBack: { state: 'needs_ok', tool: 'add_comment', at: null },
        tasks: [
          {
            id: 'task-thread',
            key: 'OPS-9',
            title: 'Fix the login timeout',
            column: 'working',
            hermesStatus: 'running',
            assignee: 'builder',
            reviewer: null,
            roomId: 'team-room',
            badge: null,
            progress: null,
            elapsedSec: null,
            note: null,
            updatedAt: at(6),
          },
        ],
      })
      const thread = await openTopicInfo(page, /Activity feed/)
      const report = thread
        .getByRole('status')
        .filter({ hasText: 'Send the result back to TCK-142' })
      await expect(report).toHaveAttribute('data-protected', 'block')
      await report.getByRole('button', { name: 'Send' }).click()
      await expect
        .poll(() => state.posts.some((item) => item.path === '/api/jobs/job-activity/report-back'))
        .toBe(true)

      const tasks = thread.getByRole('region', { name: 'Hermes tasks' })
      await expect(tasks).toContainText('Fix the login timeout')
      await expect(tasks).toContainText('OPS-9')
      await expect(tasks).toContainText('not tied to a job yet')
      await tasks.getByRole('button', { name: 'Show steps' }).click()
      await expect(tasks).toContainText('Reproduce the timeout')
      await expect(tasks).toContainText('Pick the new limit')
      await tasks.getByRole('button', { name: 'Comment' }).click()
      await tasks.getByLabel('Comment on Fix the login timeout').fill('Check the staging logs.')
      await tasks.getByRole('button', { name: 'Comment' }).click()
      await expect
        .poll(() => state.posts.some((item) => item.path === '/api/tasks/task-thread/actions'))
        .toBe(true)
      expect(
        state.posts.find((item) => item.path === '/api/tasks/task-thread/actions')?.body,
      ).toEqual({ action: 'comment', text: 'Check the staging logs.' })
    })

    test(`the general conversation's context bar uses the room session at ${size}`, async ({
      page,
    }) => {
      await pair(page)
      await mockBoldRoom(page)
      const asked: string[] = []
      await page.route('**/api/agents/lead/sessions/**', async (route) => {
        asked.push(new URL(route.request().url()).pathname)
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            asOfSeq: 12,
            window: 100000,
            used: 10000,
            measuredAt: at(7),
            model: 'demo-model',
            source: 'provider_usage',
            parts: null,
            autoCompactAt: null,
            compactions: 0,
          }),
        })
      })
      await page.goto('/b?job=job-default')
      await expect(page.locator('[data-ui="bold"] .top .word')).toBeVisible({ timeout: 20_000 })
      // 3.22.0: the meter is in the context bar under the composer (the thread panel's ring is gone; /compress is its
      // Compact). It reads the session the message lands in: the room session for the general conversation.
      const meter = page
        .locator('.bold-context-bar')
        .getByRole('button', { name: /^lead context: 10 % of 100k/ })
      await expect(meter).toBeVisible()
      await expect(meter).toContainText('10%')
      expect(asked.length).toBeGreaterThan(0)
      expect(
        asked.every((path) => path === '/api/agents/lead/sessions/score-team-room-lead/context'),
      ).toBe(true)
    })

    test(`a job-limit pause says so in Info at ${size}`, async ({ page }) => {
      await openThread(page, { exchange: budgetPause(3, 'job_limit') })
      const topic = await openTopicInfo(page, /Release notes 2\.4/)
      await expect(topic.locator('.bold-topic-status')).toContainText('Job turn limit reached (40)')
      await expect(topic.locator('.bold-topic-status')).not.toContainText('3 of 8')
    })

    test(`a 403 on the card's Step in asks to pair this browser at ${size}`, async ({ page }) => {
      await openThread(page, { exchange: budgetPause(8, 'exchange_budget') })
      await page.route('**/api/exchanges/exchange-notes/decision', async (route) =>
        route.fulfill({
          status: 403,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'forbidden', message: 'no' } }),
        }),
      )
      await openBoldJob(page, /Release notes 2\.4/)
      const card = page.getByRole('article', { name: /The exchange used its turns/ })
      await card.scrollIntoViewIfNeeded()
      await card.getByRole('button', { name: 'Step in', exact: true }).click()
      await card.getByLabel('What should happen next?').fill('Hello')
      await card.getByRole('button', { name: 'Step in', exact: true }).click()
      await expect(
        page.getByRole('alert').filter({ hasText: 'Pair this browser first.' }),
      ).toBeVisible()
    })
  })
}
