import type { Approval, Exchange, TaskSummary } from '@score/contract'
import { afterEach, vi } from 'vitest'
import { disposeRoomTest, jsonResponse, makeJob, mockFetch } from './room-test-utils.tsx'
import { resetReportBackStore } from './report-back-store.ts'

export function setupRoomRequestsTest() {
  afterEach(() => {
    disposeRoomTest()
    vi.unstubAllGlobals()
    resetReportBackStore()
  })
}

export const approval: Approval = {
  id: 'approval-1',
  origin: 'score-run',
  phase: 'human_pending',
  status: 'pending',
  actionable: true,
  linkedTo: null,
  agentId: 'builder',
  title: 'May I install a package?',
  command: 'npm install ws@8',
  cwd: '~/app',
  description: 'The websocket feed needs ws.',
  choices: ['once', 'session', 'always', 'deny'],
  createdAt: '2026-10-24T09:03:00.000Z',
  expiresAt: null,
  decision: null,
  delivery: 'none',
  blocking: null,
  refs: [],
}

export const job = makeJob({ id: 'job-1', title: 'Activity feed' })
export const other = makeJob({ id: 'job-2', title: 'Release notes', state: 'working' })

export const resolvedApproval: Approval = {
  ...approval,
  phase: 'decided',
  status: 'approved',
  actionable: false,
  decision: { choice: 'once', by: 'you', at: '2026-10-24T09:05:00.000Z' },
  delivery: 'applied',
}

export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

export function stubRoom(
  exchange: Exchange | null,
  decided = approval,
  decisionGate: Promise<void> = Promise.resolve(),
  fenced = false,
  tasks: TaskSummary[] = [],
  initialApprovals: Approval[] = [approval],
) {
  const fetchMock = mockFetch(async (url, init) => {
    if (url === '/api/orchestrations/fence')
      return jsonResponse({
        fenced,
        reason: fenced ? 'restore' : null,
        untrustedHistory: fenced,
        revision: 1,
        since: fenced ? '2026-10-24T09:00:00.000Z' : null,
        items: [],
        journal: { ok: true, entries: 4, bytes: 1200, sizeAlarm: false },
      })
    if (url === '/api/approvals?status=all') {
      if (init.method === 'POST') throw new Error('not the approvals list')
      return jsonResponse({ asOfSeq: 1, items: initialApprovals, nextCursor: null })
    }
    if (url === '/api/approvals/approval-1/decision') {
      await decisionGate
      return jsonResponse({
        ...approval,
        ...decided,
        phase: 'decided',
        status: 'approved',
        actionable: false,
        decision: { choice: 'once', by: 'you', at: '2026-10-24T09:05:00.000Z' },
        delivery: 'applied',
      })
    }
    if (url === '/api/exchanges/exchange-1/decision') {
      await decisionGate
      return jsonResponse({ asOfSeq: 0, items: [] })
    }
    if (url.startsWith('/api/tasks?'))
      return jsonResponse({
        asOfSeq: 1,
        columns: {
          planned: [],
          working: [],
          in_review: [],
          needs_you: tasks,
          done: [],
        },
      })
    if (url.startsWith('/api/tasks/'))
      return jsonResponse({
        ...tasks[0],
        body: 'The timeout needs a decision.',
        createdBy: 'you',
        steps: [],
        activity: [],
        pendingApproval: null,
        dependsOn: [],
        blocks: [],
        runIds: [],
      })
    if (url.startsWith('/api/jobs/')) {
      const items = exchange && url.includes(exchange.jobId) ? [exchange] : []
      return jsonResponse({ asOfSeq: 1, items })
    }
    return jsonResponse({ asOfSeq: 0, items: [] })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}
