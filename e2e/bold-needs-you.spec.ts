import { expect, test } from '@playwright/test'
import type {
  NeedsYou,
  OrchestrationSnapshot,
  WorkflowNeedsYou,
  WorkflowRunSnapshot,
} from '../packages/contract/src/index.ts'
import { openBoldRoom, type BoldRoomReply, type RoomRequest } from './bold-room-fixtures.ts'
import { orchestrationEvents, orchestrationSnapshot } from './orchestration-fixtures.ts'
import { runEvents, runSnapshot } from './workflow-fixtures.ts'

// PLAN 11.4b: the pinned needs-you strip on the fake adapter. Every read and mutation is a contract-shaped fixture so
// each card can be answered in place and then observed leaving the live read, at both review sizes.

test.use({ reducedMotion: 'reduce' })

const sizes = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
] as const

const at = (minute: number) => `2026-10-24T10:${String(minute).padStart(2, '0')}:00.000Z`
type Json = Record<string, unknown>

function job(id: string, title: string, extra: Json = {}): Json {
  return {
    id,
    roomId: 'team-room',
    title,
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
    createdAt: at(0),
    updatedAt: at(15),
    ...extra,
  }
}

function roomJobs(recipe?: { kind: 'orchestration' | 'workflow'; ref: string }): Json[] {
  return [
    job('job-default', 'Team room', { isDefault: true, holderAgentId: 'lead' }),
    job('job-activity', 'Activity feed'),
    job('job-notes', 'Release notes 2.4', { state: 'waiting_on_you', holderAgentId: 'lead' }),
    ...(recipe
      ? [
          job('job-run', 'Release notes run', {
            state: 'waiting_on_you',
            holderAgentId: 'lead',
            recipe,
          }),
        ]
      : []),
  ]
}

function approval(id: string, title: string): Json {
  return {
    id,
    origin: 'score-run',
    phase: 'human_pending',
    status: 'pending',
    actionable: true,
    linkedTo: null,
    agentId: 'builder',
    title,
    command: 'npm install ws@8',
    cwd: '~/app',
    description: 'The websocket feed needs ws.',
    choices: ['once', 'session', 'always', 'deny'],
    createdAt: at(7),
    expiresAt: null,
    decision: null,
    delivery: 'none',
    blocking: null,
    refs: [],
  }
}

function exchange(id: string): Json {
  return {
    id,
    jobId: 'job-notes',
    roomId: 'team-room',
    kind: 'review',
    parentId: null,
    from: 'lead',
    to: 'reviewer',
    state: 'paused_budget',
    round: 5,
    turnsUsed: 8,
    budget: 8,
    outcome: null,
    endedReason: null,
    pause: { reason: 'exchange_budget', options: ['more_turns', 'stop'] },
    queuedBehind: null,
    createdAt: at(8),
    updatedAt: at(9),
  }
}

function post(path: string): boolean {
  return (
    path.startsWith('/api/orchestrations/orch-needs/') ||
    path.startsWith('/api/workflow-runs/wfrun-needs/')
  )
}

function orchestrationRun(
  initial: NeedsYou[],
  inquiries: OrchestrationSnapshot['orchestration']['inquiries'] = [],
) {
  let needsYou = initial
  let currentInquiries = inquiries
  const snapshot = (): OrchestrationSnapshot => {
    const base = structuredClone(orchestrationSnapshot)
    base.orchestration.id = 'orch-needs'
    base.orchestration.needsYou = needsYou
    base.orchestration.inquiries = currentInquiries
    return base
  }
  return (request: RoomRequest): BoldRoomReply | undefined => {
    if (request.method === 'GET' && request.path === '/api/orchestrations/orch-needs')
      return { body: snapshot() }
    if (request.method === 'GET' && request.path === '/api/orchestrations/orch-needs/events')
      return { body: orchestrationEvents }
    if (request.method === 'POST' && post(request.path)) {
      needsYou = []
      currentInquiries = currentInquiries.map((inquiry) => ({
        ...inquiry,
        status: 'answered',
        answer: 'For the release team.',
        answeredAt: at(12),
      }))
      return { body: snapshot().orchestration }
    }
    return undefined
  }
}

function workflowRun(initial: WorkflowNeedsYou[]) {
  let needsYou = initial
  const snapshot = (): WorkflowRunSnapshot => {
    const base = structuredClone(runSnapshot)
    base.run.id = 'wfrun-needs'
    base.run.needsYou = needsYou
    base.run.status = 'running'
    return base
  }
  return (request: RoomRequest): BoldRoomReply | undefined => {
    if (request.method === 'GET' && request.path === '/api/workflow-runs/wfrun-needs')
      return { body: snapshot() }
    if (request.method === 'GET' && request.path === '/api/workflow-runs/wfrun-needs/events')
      return { body: runEvents }
    if (request.method === 'POST' && post(request.path)) {
      const kind = request.path.endsWith('/retry')
        ? 'retry'
        : request.path.endsWith('/try-again')
          ? 'refusal_limit'
          : request.path.endsWith('/remap')
            ? 'remap'
            : null
      if (kind) needsYou = needsYou.filter((item) => item.kind !== kind)
      return { body: snapshot().run }
    }
    return undefined
  }
}

for (const viewport of sizes) {
  const label = `${viewport.width}×${viewport.height}`

  test.describe(label, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize(viewport)
    })

    test(`an approval opens More and is answered in place at ${label}`, async ({ page }) => {
      const state = await openBoldRoom(page, {
        jobs: roomJobs(),
        exchanges: [],
      })
      const card = page.getByRole('article', { name: /May I install a package/ })
      await expect(card).toHaveAttribute('data-protected', 'flex')
      await expect(card).toContainText('npm install ws@8')
      await expect(card).toContainText('Activity feed')

      await card.getByRole('button', { name: 'More', exact: true }).click()
      await expect(card.getByRole('menu', { name: 'More approval choices' })).toBeVisible()
      await card.getByRole('menuitem', { name: 'Approve for this session' }).click()

      await expect(card).toHaveCount(0)
      expect(
        state.requests.find(
          (request) =>
            request.method === 'POST' &&
            request.path === '/api/approvals/approval-package/decision',
        )?.body,
      ).toEqual({ choice: 'session' })
    })

    test(`a paused exchange is answered in place at ${label}`, async ({ page }) => {
      const state = await openBoldRoom(page, {
        jobs: roomJobs(),
        approvals: [],
        exchanges: [exchange('exchange-needs')],
      })
      const card = page.getByRole('article', { name: /The exchange used its turns/ })
      await expect(card).toHaveAttribute('data-protected', 'flex')
      await expect(card).toContainText('Release notes 2.4')
      await card.getByRole('button', { name: 'Give 4 more turns' }).click()

      await expect(card).toHaveCount(0)
      expect(
        state.requests.find(
          (request) =>
            request.method === 'POST' && request.path === '/api/exchanges/exchange-needs/decision',
        )?.body,
      ).toEqual({ option: 'more_turns', turns: 4 })
    })

    test(`the strip shows one card and expands the rest at ${label}`, async ({ page }) => {
      await openBoldRoom(page, {
        jobs: roomJobs(),
        approvals: [
          approval('approval-package', 'May I install a package?'),
          approval('approval-deploy', 'May I deploy?'),
        ],
        exchanges: [],
      })
      const first = page.getByRole('article', { name: /May I install a package/ })
      const second = page.getByRole('article', { name: /May I deploy/ })
      await expect(first).toBeVisible()
      await expect(second).toBeHidden()
      await expect(page.locator('.bold-pins')).toHaveAttribute('data-expanded', 'false')

      await page.getByRole('button', { name: '1 more needs you' }).click()
      await expect(second).toBeVisible()
      await expect(page.locator('.bold-pins')).toHaveAttribute('data-expanded', 'true')
      await page.getByRole('button', { name: 'Show fewer' }).click()
      await expect(second).toBeHidden()
    })

    test(`a question from the lead is answered in place at ${label}`, async ({ page }) => {
      const state = await openBoldRoom(page, {
        jobs: roomJobs({ kind: 'orchestration', ref: 'orch-needs' }),
        approvals: [],
        exchanges: [],
        handle: orchestrationRun(
          [{ kind: 'inquiry', inquiryId: 'inq-1' }],
          [
            {
              id: 'inq-1',
              question: 'Should the release notes mention the migration steps?',
              status: 'open',
              answer: null,
              revision: 1,
              createdAt: at(9),
              answeredAt: null,
            },
          ],
        ),
      })
      const card = page.getByRole('article', { name: /The lead asks/ })
      await expect(card).toHaveAttribute('data-protected', 'flex')
      await expect(card).toContainText('Should the release notes mention the migration steps?')
      await card.getByLabel(/Your answer/).fill('For the release team.')
      await card.getByRole('button', { name: 'Send answer' }).click()

      await expect(card).toHaveCount(0)
      expect(
        state.requests.find(
          (request) =>
            request.method === 'POST' &&
            request.path === '/api/orchestrations/orch-needs/inquiries/inq-1/answer',
        )?.body,
      ).toMatchObject({
        answer: 'For the release team.',
        expectedRevision: 1,
        orchestrationRevision: 9,
      })
    })

    test(`spend that is not settled is answered in place at ${label}`, async ({ page }) => {
      const state = await openBoldRoom(page, {
        jobs: roomJobs({ kind: 'orchestration', ref: 'orch-needs' }),
        approvals: [],
        exchanges: [],
        handle: orchestrationRun([{ kind: 'budget', reason: 'unknown_spend' }]),
      })
      const card = page.getByRole('article', { name: /Spend not settled/ })
      await expect(card).toHaveAttribute('data-protected', 'flex')
      await expect(card).toContainText('Spend is unknown: decide whether to continue')
      await card.getByRole('button', { name: 'Continue although spend is unknown' }).click()

      await expect(card).toHaveCount(0)
      expect(
        state.requests.find(
          (request) =>
            request.method === 'POST' && request.path === '/api/orchestrations/orch-needs/limits',
        )?.body,
      ).toEqual({ orchestrationRevision: 9, acceptUnknownSpend: true })
    })

    test(`a low quota guard is answered in place at ${label}`, async ({ page }) => {
      const state = await openBoldRoom(page, {
        jobs: roomJobs({ kind: 'orchestration', ref: 'orch-needs' }),
        approvals: [],
        exchanges: [],
        handle: orchestrationRun([
          {
            kind: 'quota_low',
            stepId: 's3',
            agentId: 'builder',
            window: '5 hours',
            group: null,
            leftPercent: 12,
            resetsAt: at(30),
          },
        ]),
      })
      const card = page.getByRole('article', { name: /Quota is low/ })
      await expect(card).toHaveAttribute('data-protected', 'flex')
      await expect(card).toContainText('has 12% of its 5 hours limit left')
      await card.getByRole('button', { name: 'Use it anyway' }).click()

      await expect(card).toHaveCount(0)
      expect(
        state.requests.find(
          (request) =>
            request.method === 'POST' &&
            request.path === '/api/orchestrations/orch-needs/steps/s3/quota',
        )?.body,
      ).toEqual({ answer: 'use_anyway', orchestrationRevision: 9 })
    })

    test(`work that is not confirmed as ended is answered in place at ${label}`, async ({
      page,
    }) => {
      const state = await openBoldRoom(page, {
        jobs: roomJobs({ kind: 'orchestration', ref: 'orch-needs' }),
        approvals: [],
        exchanges: [],
        handle: orchestrationRun([{ kind: 'unknown', attemptId: 'a3' }]),
      })
      const card = page.getByRole('article', { name: /Not confirmed as ended/ })
      await expect(card).toHaveAttribute('data-protected', 'flex')
      await card.getByLabel(/This may still be running/).check()
      await card.getByRole('button', { name: 'Stop waiting for this' }).click()

      await expect(card).toHaveCount(0)
      expect(
        state.requests.find(
          (request) =>
            request.method === 'POST' && request.path === '/api/orchestrations/orch-needs/abandon',
        )?.body,
      ).toEqual({ attemptIds: ['a3'], orchestrationRevision: 9, acknowledge: true })
    })

    test(`retry, try again and remap are answered in place at ${label}`, async ({ page }) => {
      const state = await openBoldRoom(page, {
        jobs: roomJobs({ kind: 'workflow', ref: 'wfrun-needs' }),
        approvals: [],
        exchanges: [],
        handle: workflowRun([
          { kind: 'retry', nodeId: 'review', attemptsLeft: 1 },
          { kind: 'refusal_limit', nodeId: 'review', attemptId: 'h-review', refusals: 3 },
          {
            kind: 'remap',
            agentId: 'reviewer',
            frozenIncarnation: 'inc-reviewer-old',
            currentIncarnation: 'inc-reviewer-new',
            nodeIds: ['review'],
            plan: [
              {
                nodeId: 'review',
                retiresAttemptId: null,
                payloadHash: 'review-payload',
                payload: 'Review the draft.',
              },
            ],
          },
        ]),
      })
      await page.getByRole('button', { name: '2 more need you' }).click()

      const retry = page
        .getByRole('article', { name: /A step needs another try/ })
        .filter({ hasText: 'You stopped waiting for Review the draft' })
      await retry.getByLabel(/earlier try may still be running/).check()
      await retry.getByRole('button', { name: 'Retry Review the draft' }).click()
      await expect(retry).toHaveCount(0)

      const refusal = page
        .getByRole('article', { name: /A step needs another try/ })
        .filter({ hasText: 'Hermes has refused this step 3 times' })
      await refusal.getByRole('button', { name: 'Try again' }).click()
      await expect(refusal).toHaveCount(0)

      const remap = page
        .getByRole('article', { name: /A step needs another try/ })
        .filter({ hasText: 'was replaced' })
      await remap.getByRole('button', { name: 'Use the new reviewer for this run' }).click()
      await expect(remap).toHaveCount(0)

      const paths = state.requests
        .filter((request) => request.method === 'POST')
        .map((request) => request.path)
      expect(paths).toEqual(
        expect.arrayContaining([
          '/api/workflow-runs/wfrun-needs/nodes/review/retry',
          '/api/workflow-runs/wfrun-needs/nodes/review/try-again',
          '/api/workflow-runs/wfrun-needs/remap',
        ]),
      )
    })
  })
}
