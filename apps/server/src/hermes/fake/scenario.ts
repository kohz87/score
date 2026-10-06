import type { AgentSummary, Approval, RunSummary } from '@score/contract'
import type { DomainEventDraft } from '../../hub/ingest.ts'
import type { HermesPort } from '../port.ts'

export type ScenarioStep = {
  [T in DomainEventDraft['type']]: {
    at: number
    kind: T
    data: Extract<DomainEventDraft, { type: T }>['data']
  }
}[DomainEventDraft['type']]

export function exampleAgents(): AgentSummary[] {
  return [
    { id: 'lead', role: 'Leads the team', color: '#6B4EFF', shape: 'circle-dot' },
    { id: 'builder', role: 'Builds features', color: '#19C39A', shape: 'triangle' },
    { id: 'reviewer', role: 'Reviews changes', color: '#FFB61E', shape: 'diamond' },
    { id: 'designer', role: 'Designs interfaces', color: '#FF6B8A', shape: 'square' },
  ].map(({ id, role, color, shape }) => ({
    id,
    name: id,
    role,
    style: { color, shape: shape as AgentSummary['style']['shape'] },
    status: 'idle',
    activity: null,
    model: { id: 'fake-model', label: 'Demo model' },
    served: true,
  }))
}

export function fakeStatus(): ReturnType<HermesPort['status']> {
  return {
    hermes: {
      version: null,
      reachable: true,
      apiServer: true,
      capabilities: [],
      servedProfiles: exampleAgents().map((agent) => agent.id),
    },
    bridge: { producers: 0, lastSeenAt: null, isolation: 'unknown' },
    compatibility: { fingerprint: 'fake', tested: true, disabled: [] },
    agentIsolation: 'same_user',
    degraded: [],
  }
}

export function exampleRun(agentId: string, id: string, at: string): RunSummary {
  return {
    id,
    agentId,
    origin: 'score',
    status: 'queued',
    startedAt: at,
    endedAt: null,
    model: 'fake-model',
    toolsUsed: [],
    tokens: null,
    costUsd: null,
    refs: [],
    gaps: [],
  }
}

export function createScenario(startedAt: number): ScenarioStep[] {
  const time = (at: number) => new Date(startedAt + at).toISOString()
  const agents = exampleAgents()
  const taskId = 'task-pagination'
  const roomId = 'room-activity-feed'
  const briefId = 'brief-pagination'
  const run = {
    ...exampleRun('builder', 'scenario-build', time(600)),
    refs: [{ kind: 'task' as const, taskId }],
  }
  const task = {
    id: taskId,
    key: 'T-101',
    title: 'Add pagination to the activity feed',
    column: 'working' as const,
    hermesStatus: 'running',
    assignee: 'builder',
    reviewer: 'reviewer',
    roomId,
    badge: null,
    progress: 0.2,
    elapsedSec: 0,
    note: 'Keep the newest activity visible',
    updatedAt: time(700),
  }
  const block = {
    id: 'block-build',
    label: 'Build feed pagination',
    state: 'working' as const,
    start: time(800),
    end: null,
    taskId,
    runId: run.id,
  }
  const approval = (origin: Approval['origin'], agentId: string, at: number): Approval => ({
    id: `approval-${origin}`,
    origin,
    phase: 'human_pending',
    status: 'pending',
    actionable: true,
    agentId,
    title: 'May I install the project dependencies?',
    command: 'pnpm install --frozen-lockfile',
    cwd: 'demo-project',
    description: 'Installing dependencies needs your approval.',
    choices:
      origin === 'kanban' ? ['once', 'always', 'deny'] : ['once', 'session', 'always', 'deny'],
    createdAt: time(at),
    expiresAt: null,
    decision: null,
    delivery: 'none',
    blocking: 'Only this install is waiting; the rest of the team can continue.',
    refs: [{ kind: 'task', taskId }],
  })
  const scoreApproval = approval('score-run', 'builder', 2000)
  const gap = {
    from: time(4000),
    to: time(5000),
    reason: 'Demo connection interrupted; this interval could not be recovered.',
  }
  return [
    { at: 0, kind: 'system.status', data: { mode: 'fake', ...fakeStatus() } },
    ...agents.map((agent, index): ScenarioStep => ({
      at: 100 + index * 100,
      kind: 'agent.updated',
      data: agent,
    })),
    { at: 600, kind: 'run.updated', data: run },
    { at: 700, kind: 'task.upserted', data: task },
    { at: 800, kind: 'lane.upserted', data: { briefId, agentId: 'builder', block } },
    {
      at: 900,
      kind: 'agent.updated',
      data: { ...agents[1]!, status: 'working', activity: 'Adding feed pagination' },
    },
    { at: 1000, kind: 'run.updated', data: { ...run, status: 'running' } },
    {
      at: 1100,
      kind: 'typing',
      data: { roomId, agentId: 'lead', text: 'is outlining the next steps' },
    },
    {
      at: 1200,
      kind: 'message.created',
      data: {
        id: 'message-plan',
        roomId,
        author: { kind: 'agent', agentId: 'lead' },
        to: ['builder', 'reviewer', 'designer'],
        parts: [{ kind: 'text', text: 'Let’s add pagination' }],
        createdAt: time(1200),
        streaming: true,
        refs: [{ kind: 'task', taskId }],
      },
    },
    {
      at: 1400,
      kind: 'message.delta',
      data: {
        messageId: 'message-plan',
        roomId,
        append: ' while keeping the newest activity visible.',
      },
    },
    { at: 1600, kind: 'message.completed', data: { messageId: 'message-plan', roomId } },
    { at: 1700, kind: 'typing', data: { roomId, agentId: 'lead', text: null } },
    { at: 2000, kind: 'approval.requested', data: scoreApproval },
    { at: 2300, kind: 'approval.requested', data: approval('gateway', 'designer', 2300) },
    { at: 2600, kind: 'approval.requested', data: approval('kanban', 'reviewer', 2600) },
    {
      at: 3000,
      kind: 'approval.updated',
      data: {
        ...scoreApproval,
        phase: 'decided',
        status: 'approved',
        decision: { choice: 'once', by: 'elsewhere', at: time(3000) },
        delivery: 'applied',
      },
    },
    {
      at: 3200,
      kind: 'log.line',
      data: {
        id: 'log-check',
        at: time(3200),
        agentId: 'builder',
        kind: 'tool',
        text: 'Ran the pagination checks: 12 passed.',
      },
    },
    {
      at: 3400,
      kind: 'watch.frame',
      data: {
        seq: 1,
        at: time(3400),
        agentId: 'builder',
        runId: run.id,
        surface: 'terminal',
        terminal: {
          cwd: 'demo-project',
          command: 'pnpm test -- pagination',
          output: '12 checks passed',
          status: 'ok',
        },
        caption: 'Checked pagination behavior',
      },
    },
    {
      at: 3800,
      kind: 'watch.frame',
      data: {
        seq: 2,
        at: time(3800),
        agentId: 'builder',
        runId: run.id,
        surface: 'editor',
        editor: {
          path: 'src/activity-feed.ts',
          diff: '+ const pageSize = 25',
          language: 'typescript',
        },
        caption: 'Added the page size to the feed',
      },
    },
    { at: 5000, kind: 'gap.recorded', data: { source: 'fake', runId: run.id, ...gap } },
    { at: 5100, kind: 'run.updated', data: { ...run, status: 'running', gaps: [gap] } },
    {
      at: 5500,
      kind: 'watch.frame',
      data: {
        seq: 3,
        at: time(5500),
        agentId: 'designer',
        runId: null,
        surface: 'browser',
        browser: { url: 'https://demo.example/activity', title: 'Activity feed', imageUrl: null },
        caption: 'Reviewed the pagination controls',
      },
    },
    {
      at: 6000,
      kind: 'task.activity',
      data: {
        taskId,
        item: { at: time(6000), agentId: 'designer', text: 'Pagination controls look clear.' },
      },
    },
    {
      at: 6500,
      kind: 'lane.upserted',
      data: { briefId, agentId: 'builder', block: { ...block, state: 'done', end: time(6500) } },
    },
    {
      at: 6600,
      kind: 'lane.upserted',
      data: {
        briefId,
        agentId: 'reviewer',
        block: {
          ...block,
          id: 'block-review',
          label: 'Review pagination',
          start: time(6600),
          runId: null,
        },
      },
    },
    {
      at: 6700,
      kind: 'handoff.created',
      data: {
        briefId,
        handoff: {
          id: 'handoff-review',
          from: { agentId: 'builder', blockId: block.id },
          to: { agentId: 'reviewer', blockId: 'block-review' },
          kind: 'review',
          at: time(6700),
        },
      },
    },
    {
      at: 7000,
      kind: 'task.upserted',
      data: {
        ...task,
        column: 'in_review',
        hermesStatus: 'review',
        progress: 1,
        updatedAt: time(7000),
      },
    },
    {
      at: 8000,
      kind: 'run.updated',
      data: {
        ...run,
        status: 'completed',
        endedAt: time(8000),
        toolsUsed: ['terminal', 'editor'],
        gaps: [gap],
      },
    },
    { at: 8100, kind: 'agent.updated', data: agents[1]! },
    {
      at: 9000,
      kind: 'memory.saved',
      data: {
        agentIds: agents.map((agent) => agent.id),
        text: 'Keep the newest activity visible when loading another page.',
        source: { kind: 'task', taskId },
      },
    },
    {
      at: 10000,
      kind: 'task.upserted',
      data: {
        ...task,
        column: 'done',
        hermesStatus: 'done',
        progress: 1,
        elapsedSec: 10,
        updatedAt: time(10000),
      },
    },
  ]
}
