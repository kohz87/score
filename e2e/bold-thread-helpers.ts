import { expect, type Page } from '@playwright/test'
import { mockBoldRoom, openBoldJob } from './bold-room-fixtures.ts'
import { pair } from './pair.ts'

// PLAN 11.4c, moved in 3.22.0: the thread panel is gone. Its parts live in Info › This topic (status, rounds and turns,
// Stop, run card, report-back, tasks), on the needs-you card (a paused exchange, step in) and in the chat itself. The seeded fake room moves over time, so the contract-shaped
// reads are pinned to fixtures (as in bold-room.spec.ts); the shell, pairing and request validation stay real.

export const sizes = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
] as const

export const at = (minute: number) => `2026-10-24T10:${String(minute).padStart(2, '0')}:00.000Z`

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

export async function openThread(
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
export async function openTopicInfo(page: Page, title: RegExp, only = false) {
  // 3.28.0: a chat with one active job has no list to pick from; that job is the current one and Info shows This job.
  if (!only) await openBoldJob(page, title)
  if ((page.viewportSize()?.width ?? 1440) <= 860)
    await page.getByRole('button', { name: 'Chat info' }).click()
  const section = page.locator('.bold-topic-info')
  await expect(section).toBeVisible()
  return section
}

export const recipeRoom = {
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

export function recipeJob(id: string, title: string, isDefault: boolean, recipe: unknown) {
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

export const orchestration = {
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

export function budgetPause(turnsUsed: number, reason: 'exchange_budget' | 'job_limit') {
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
