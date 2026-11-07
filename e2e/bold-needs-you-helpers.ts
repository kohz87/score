import type {
  NeedsYou,
  OrchestrationSnapshot,
  WorkflowNeedsYou,
  WorkflowRunSnapshot,
} from '../packages/contract/src/index.ts'
import type { BoldRoomReply, RoomRequest } from './bold-room-fixtures.ts'
import { orchestrationEvents, orchestrationSnapshot } from './orchestration-fixtures.ts'
import { runEvents, runSnapshot } from './workflow-fixtures.ts'

// PLAN 11.4b: shared fixtures for the pinned needs-you strip on the fake adapter. Every read and mutation is a
// contract-shaped fixture so each card can be answered in place and then observed leaving the live read.

export const sizes = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
] as const

export const at = (minute: number) => `2026-10-24T10:${String(minute).padStart(2, '0')}:00.000Z`
export type Json = Record<string, unknown>

export function job(id: string, title: string, extra: Json = {}): Json {
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

export function roomJobs(recipe?: { kind: 'orchestration' | 'workflow'; ref: string }): Json[] {
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

export function approval(id: string, title: string): Json {
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

export function exchange(id: string): Json {
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

export function orchestrationRun(
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
    // The strip's count reads the list; the cards read the run. Serve both from the same state.
    if (request.method === 'GET' && request.path === '/api/orchestrations')
      return { body: { asOfSeq: 1, items: [snapshot().orchestration] } }
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

export function workflowRun(initial: WorkflowNeedsYou[]) {
  let needsYou = initial
  const snapshot = (): WorkflowRunSnapshot => {
    const base = structuredClone(runSnapshot)
    base.run.id = 'wfrun-needs'
    base.run.needsYou = needsYou
    base.run.status = 'running'
    return base
  }
  return (request: RoomRequest): BoldRoomReply | undefined => {
    if (request.method === 'GET' && request.path === '/api/workflow-runs')
      return { body: { asOfSeq: 1, items: [snapshot().run] } }
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
