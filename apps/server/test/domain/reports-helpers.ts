import type {
  KanbanTaskFact,
  ReportApproval,
  ReportInput,
  ReportRun,
} from '../../src/domain/reports.ts'

// UTC+2 all year (no DST), so local days are easy to reason about.
export const tz = 'Etc/GMT-2'
export const now = Date.parse('2026-03-10T10:00:00Z')

export const t = (iso: string) => Date.parse(`2026-${iso}Z`)
export const kanban = (
  id: string,
  over: Partial<Omit<KanbanTaskFact, 'events'>> & { events?: [string, string][] },
): KanbanTaskFact => ({
  id,
  assignee: 'builder',
  status: 'done',
  createdAt: t('03-10T06:00:00'),
  completedAt: null,
  hasParents: false,
  ...over,
  events: (over.events ?? []).map(([kind, at], index) => ({
    id: index + 1,
    kind,
    at: t(at),
    // The implementer (the task's assignee in these fixtures) waits on a review.
    actor: kind === 'review_requested' ? (over.assignee ?? 'builder') : null,
  })),
})
const tasks: KanbanTaskFact[] = [
  kanban('k1', {
    createdAt: t('03-10T07:00:00'),
    completedAt: t('03-10T08:00:00'),
    events: [
      ['review_requested', '03-10T07:40:00'],
      ['completed', '03-10T08:00:00'],
    ],
  }),
  // A review round that sent the work back, finished at 00:30 local on the 10th.
  kanban('k2', {
    createdAt: t('03-09T20:00:00'),
    completedAt: t('03-09T22:30:00'),
    events: [
      ['review_requested', '03-09T21:00:00'],
      ['changes_requested', '03-09T21:30:00'],
      ['review_requested', '03-09T22:00:00'],
      ['completed', '03-09T22:30:00'],
    ],
  }),
  // Finished without a review: 23:30 local on the 9th.
  kanban('k3', { createdAt: t('03-09T21:00:00'), completedAt: t('03-09T21:30:00') }),
  kanban('k4', {
    assignee: 'designer',
    createdAt: t('03-05T11:40:00'),
    completedAt: t('03-05T12:00:00'),
    events: [
      ['review_requested', '03-05T11:50:00'],
      ['completed', '03-05T12:00:00'],
    ],
  }),
  kanban('k5', {
    assignee: 'designer',
    createdAt: t('03-01T11:00:00'),
    completedAt: t('03-01T12:00:00'),
  }),
  kanban('k6', { status: 'running' }),
  kanban('k7', { status: 'blocked', events: [['blocked', '03-10T09:00:00']] }),
  // Had parents: waited 06:00-07:00 until promoted.
  kanban('k8', {
    assignee: 'designer',
    status: 'ready',
    hasParents: true,
    events: [['promoted', '03-10T07:00:00']],
  }),
  // Has parents and is still waiting for them.
  kanban('k9', { status: 'todo', hasParents: true, createdAt: t('03-10T09:30:00') }),
]
export const run = (agentId: string, startedAt: string, endedAt: string | null): ReportRun => ({
  agentId,
  startedAt,
  endedAt,
})
const runs = [
  run('builder', '2026-03-10T08:00:00.000Z', '2026-03-10T09:00:00.000Z'),
  run('builder', '2026-03-10T08:30:00.000Z', '2026-03-10T09:30:00.000Z'),
  run('designer', '2026-03-05T10:00:00.000Z', '2026-03-05T10:10:00.000Z'),
  run('designer', '2026-03-01T10:00:00.000Z', '2026-03-01T10:10:00.000Z'),
]
export const approval = (over: Partial<ReportApproval>): ReportApproval => ({
  agentId: 'builder',
  stage: 'human',
  visible: true,
  status: 'approved',
  decisionBy: 'you',
  createdAt: '2026-03-10T08:00:00.000Z',
  decidedAt: '2026-03-10T08:10:00.000Z',
  closedAt: null,
  ...over,
})
const approvals = [
  approval({}),
  approval({
    status: 'denied',
    createdAt: '2026-03-10T09:00:00.000Z',
    decidedAt: '2026-03-10T09:30:00.000Z',
  }),
  approval({ visible: false, createdAt: '2026-03-10T08:00:00.000Z' }),
  approval({
    stage: 'guardian',
    visible: false,
    decisionBy: 'guardian',
    createdAt: '2026-03-10T07:00:00.000Z',
    decidedAt: '2026-03-10T07:30:00.000Z',
  }),
  approval({
    agentId: 'designer',
    status: 'pending',
    decisionBy: null,
    createdAt: '2026-03-10T09:00:00.000Z',
    decidedAt: null,
  }),
]
export const input: ReportInput = {
  range: '7d',
  now,
  tz,
  agentIds: ['builder', 'designer', 'reviewer'],
  runs,
  approvals,
  facts: { tasks, spendUsd: { builder: 1.5, designer: null, reviewer: 0.25 } },
}
