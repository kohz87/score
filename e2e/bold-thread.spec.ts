import { expect, test, type Page } from '@playwright/test'
import { mockBoldRoom, openBoldJob } from './bold-room-fixtures.ts'
import { pair } from './pair.ts'

// PLAN 11.4c: a job's thread in the bold side panel. The seeded fake room moves over time, so the contract-shaped
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
      if (path === '/api/jobs/job-activity/stop') {
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
    const handled = options.handle?.(path, request.method())
    if (handled) return json(handled.body, handled.status)
    return route.fallback()
  })
  await page.goto('/b')
  await expect(page.locator('[data-ui="bold"] .top .word')).toBeVisible({ timeout: 20_000 })
  return { ...state, posts }
}

async function openJobThread(page: Page, title: RegExp) {
  await openBoldJob(page, title)
  await page.locator('.bold-job-thread').click()
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

for (const viewport of sizes) {
  const size = `${viewport.width}×${viewport.height}`
  test.describe(size, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize(viewport)
    })

    test(`a live job's thread shows rounds, turns, step-in, compact and stop at ${size}`, async ({
      page,
    }) => {
      const state = await openThread(page)
      await openJobThread(page, /Activity feed/)

      const thread = page.locator('.bold-thread')
      await expect(thread.getByRole('heading', { name: 'Activity feed', level: 2 })).toBeVisible()
      await expect(thread.locator('.bold-thread-status').first()).toContainText('5 of 8 turns used')
      await expect(thread.getByRole('heading', { name: 'Round 1' })).toBeVisible()
      await expect(thread.getByRole('heading', { name: 'Round 2' })).toBeVisible()
      await expect(thread).toContainText('The cursor jumps on refresh.')
      await expect(thread).toContainText('Cursor is stable now.')
      // Round 2 starts after the send-back, so the fix sits under it and the first cut under Round 1.
      await expect(
        page.getByRole('region', { name: 'Round 1 messages' }).getByText('The cursor jumps'),
      ).toBeVisible()
      await expect(
        page.getByRole('region', { name: 'Round 2 messages' }).getByText('Cursor is stable now.'),
      ).toBeVisible()

      // No exchange waits on the person, so no decision card shows.
      await expect(page.locator('.bold-thread .bold-request')).toHaveCount(0)

      // Step in: an ordinary message to the job.
      await page.getByLabel('Step in', { exact: true }).fill('Also cover the empty state.')
      await page.getByRole('button', { name: 'Send step-in' }).click()
      await expect(page.getByRole('status').filter({ hasText: 'Message sent.' })).toBeVisible()
      expect(
        state.requests.some(
          (item) =>
            item.method === 'POST' &&
            item.path === '/api/rooms/team-room/messages' &&
            JSON.stringify(item.body) ===
              JSON.stringify({ text: 'Also cover the empty state.', jobId: 'job-activity' }),
        ),
      ).toBe(true)

      // Compact asks the job's own session.
      await page.getByRole('button', { name: /builder context: 42 %/ }).click()
      await page.getByRole('button', { name: 'Compact', exact: true }).click()
      await page.getByRole('button', { name: 'Compact now' }).click()
      await expect
        .poll(() => state.posts.filter((item) => item.path.endsWith('/compact')).length)
        .toBe(1)
      // The ring toggles the popover; Escape would also close the phone sheet.
      await page.getByRole('button', { name: /builder context: 42 %/ }).click()

      // Stop asks first, and the confirmation is a protected surface.
      await page.getByRole('button', { name: 'Stop', exact: true }).click()
      const confirm = page.getByRole('alertdialog', { name: 'Stop Activity feed?' })
      await expect(confirm).toHaveAttribute('data-protected', 'block')
      await confirm.getByRole('button', { name: 'Keep going' }).click()
      await expect(confirm).toHaveCount(0)
      expect(state.posts.some((item) => item.path === '/api/jobs/job-activity/stop')).toBe(false)
      await page.getByRole('button', { name: 'Stop', exact: true }).click()
      await page.getByRole('button', { name: 'Stop job' }).click()
      await expect(page.getByRole('status').filter({ hasText: 'Stop sent.' })).toBeVisible()
      expect(
        state.posts.filter((item) => item.path === '/api/jobs/job-activity/stop'),
      ).toHaveLength(1)

      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        viewport.width,
      )
    })

    test(`a thread message has the action row and delete works at ${size}`, async ({ page }) => {
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
      await openJobThread(page, /Activity feed/)
      const own = page.locator('.bold-thread-message[data-message-id="t-1"]')
      await own.hover()
      await expect(own.getByRole('button', { name: 'Edit message from You' })).toBeVisible()
      await expect(own.getByRole('button', { name: 'Copy message from You' })).toBeVisible()
      await expect(own.getByRole('button', { name: 'Pin message from You' })).toBeVisible()
      const reply = page.locator('.bold-thread-message[data-message-id="t-2"]')
      await reply.hover()
      await expect(reply.getByRole('button', { name: 'Retry reply from builder' })).toBeVisible()

      // An agent's message goes at once (undo window), then the DELETE is sent.
      await reply.getByRole('button', { name: 'Delete message from builder' }).click()
      await expect(page.getByText('First cut is ready for review.')).toHaveCount(0)
      await expect
        .poll(() => deletes, { timeout: 15_000 })
        .toEqual(['/api/rooms/team-room/messages/t-2'])
    })

    test(`a paused exchange is answered from the thread at ${size}`, async ({ page }) => {
      const state = await openThread(page)
      await openJobThread(page, /Release notes 2\.4/)

      const thread = page.locator('.bold-thread')
      await expect(
        thread.getByRole('heading', { name: 'Release notes 2.4', level: 2 }),
      ).toBeVisible()
      const card = thread.locator('.bold-request[data-protected]')
      await expect(card).toHaveCount(1)
      await expect(card).toContainText('8 of 8')
      await card.getByRole('button', { name: /Send back/ }).click()
      await card.getByLabel('Note for the author').fill('Tighten the migration steps.')
      await card
        .getByRole('button', { name: /Send back/ })
        .last()
        .click()
      await expect(card).toContainText('Sent back with your note.')
      expect(
        state.requests.some(
          (item) =>
            item.method === 'POST' &&
            item.path === '/api/exchanges/exchange-notes/decision' &&
            JSON.stringify(item.body) ===
              JSON.stringify({ option: 'send_back', note: 'Tighten the migration steps.' }),
        ),
      ).toBe(true)
    })

    test(`the step-in box answers a budget pause with step_in at ${size}`, async ({ page }) => {
      const state = await openThread(page, {
        exchange: {
          id: 'exchange-notes',
          jobId: 'job-notes',
          roomId: 'team-room',
          kind: 'ask',
          parentId: null,
          from: 'lead',
          to: 'reviewer',
          state: 'paused_budget',
          round: 1,
          turnsUsed: 8,
          budget: 8,
          outcome: null,
          endedReason: null,
          pause: { reason: 'exchange_budget', options: ['more_turns', 'step_in', 'stop'] },
          queuedBehind: null,
          createdAt: at(8),
          updatedAt: at(9),
        },
      })
      await openJobThread(page, /Release notes 2\.4/)
      await expect(
        page.locator('.bold-thread .bold-status, .bold-thread-status').first(),
      ).toContainText('8 of 8 turns used')
      await page.getByLabel('Step in', { exact: true }).fill('Go on with the short version.')
      await page.getByRole('button', { name: 'Send step-in' }).click()
      await expect(page.getByRole('status').filter({ hasText: 'Step in sent.' })).toBeVisible()
      expect(
        state.requests.some(
          (item) =>
            item.method === 'POST' &&
            item.path === '/api/exchanges/exchange-notes/decision' &&
            JSON.stringify(item.body) ===
              JSON.stringify({ option: 'step_in', text: 'Go on with the short version.' }),
        ),
      ).toBe(true)
    })

    test(`a job with a recipe shows its run card with the step count at ${size}`, async ({
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
        const path = new URL(route.request().url()).pathname
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
          return json({ asOfSeq: 12, items: [], nextCursor: null, jobId: 'job-plan' })
        return route.fallback()
      })
      await page.goto('/b')
      await expect(page.locator('[data-ui="bold"] .top .word')).toBeVisible({ timeout: 20_000 })
      await openJobThread(page, /Activity feed plan/)
      const card = page.getByRole('region', { name: 'Recipe run' })
      await expect(card).toContainText('Orchestration')
      await expect(card).toContainText('Activity feed plan')
      await expect(card).toContainText('2 of 4 steps done')
      await expect(card.getByRole('link', { name: 'Open the run' })).toHaveAttribute(
        'href',
        /\/runs\/brief-activity$/,
      )
    })

    test(`the thread shows report-back, sends it, and lists Hermes tasks at ${size}`, async ({
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
      await openJobThread(page, /Activity feed/)
      const thread = page.locator('.bold-thread')
      const report = thread
        .getByRole('status')
        .filter({ hasText: 'Send the result back to TCK-142' })
      await expect(report).toHaveAttribute('data-protected', 'block')
      await report.getByRole('button', { name: 'Send' }).click()
      await expect
        .poll(() => state.posts.some((item) => item.path === '/api/jobs/job-activity/report-back'))
        .toBe(true)

      const tasks = thread.getByRole('region', { name: 'Room tasks' })
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

    test(`the default job's thread uses the room session at ${size}`, async ({ page }) => {
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
      if (viewport.width < 861) await page.getByRole('button', { name: 'Open side panel' }).click()
      await page.locator('button.side-toggle').click()
      await page.getByRole('button', { name: /^Thread/ }).click()
      await expect(page.getByRole('button', { name: /lead context: 10 %/ })).toBeVisible()
      expect(asked.length).toBeGreaterThan(0)
      expect(
        asked.every((path) => path === '/api/agents/lead/sessions/score-team-room-lead/context'),
      ).toBe(true)
    })

    test(`a job-limit pause says so in the header at ${size}`, async ({ page }) => {
      await openThread(page, {
        exchange: {
          id: 'exchange-notes',
          jobId: 'job-notes',
          roomId: 'team-room',
          kind: 'ask',
          parentId: null,
          from: 'lead',
          to: 'reviewer',
          state: 'paused_budget',
          round: 1,
          turnsUsed: 3,
          budget: 8,
          outcome: null,
          endedReason: null,
          pause: { reason: 'job_limit', options: ['more_turns', 'stop'] },
          queuedBehind: null,
          createdAt: at(8),
          updatedAt: at(9),
        },
      })
      await openJobThread(page, /Release notes 2\.4/)
      await expect(page.locator('.bold-thread-status').first()).toContainText(
        'Job turn limit reached (40)',
      )
      await expect(page.locator('.bold-thread-status').first()).not.toContainText('3 of 8')
    })

    test(`a 403 on the step-in box asks to pair this browser at ${size}`, async ({ page }) => {
      await openThread(page)
      await page.route('**/api/rooms/team-room/messages', async (route) => {
        if (route.request().method() !== 'POST') return route.fallback()
        return route.fulfill({
          status: 403,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'forbidden', message: 'no' } }),
        })
      })
      await openJobThread(page, /Activity feed/)
      await page.getByLabel('Step in', { exact: true }).fill('Hello')
      await page.getByRole('button', { name: 'Send step-in' }).click()
      await expect(
        page.getByRole('alert').filter({ hasText: 'Pair this browser first.' }),
      ).toBeVisible()
    })
  })
}
