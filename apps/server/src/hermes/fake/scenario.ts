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

export const scenarioDuration = 180000

export function createScenario(startedAt: number, loop = 0): ScenarioStep[] {
  const id = (base: string) => `${base}-${loop}`
  const time = (at: number) => new Date(startedAt + at * 18).toISOString()
  const agents = exampleAgents()
  const taskId = id('task-pagination')
  const roomId = 'room-activity-feed'
  // A brief's id is its root message, here the person's ask at the top of the room.
  const briefId = id('message-brief')
  const reviewTaskId = id('task-review')
  const run = {
    ...exampleRun('builder', id('scenario-build'), time(600)),
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
    id: id('block-build'),
    label: 'Build feed pagination',
    state: 'working' as const,
    start: time(800),
    end: null,
    taskId,
    runId: run.id,
  }
  const reviewRun = {
    ...exampleRun('reviewer', id('scenario-review'), time(6650)),
    refs: [{ kind: 'task' as const, taskId: reviewTaskId }],
  }
  const approval = (origin: Approval['origin'], agentId: string, at: number): Approval => ({
    id: id(`approval-${origin}`),
    origin,
    phase: 'human_pending',
    status: 'pending',
    actionable: origin !== 'kanban',
    linkedTo: null,
    agentId,
    ...{
      'score-run': {
        title: 'May I install the pagination dependency?',
        command: 'pnpm add @tanstack/react-virtual@3.13.12',
      },
      gateway: {
        title: 'May I push the pagination branch?',
        command: 'git push origin task/feed-pagination',
      },
      kanban: {
        title: 'Blocked in unattended mode',
        command: 'rm -rf demo-project/dist',
      },
    }[origin],
    cwd: 'demo-project',
    description: 'This command changes the workspace or remote repository and needs your approval.',
    choices: origin === 'kanban' ? [] : ['once', 'session', 'always', 'deny'],
    createdAt: time(at),
    expiresAt: null,
    decision: null,
    delivery: 'none',
    blocking: 'Only this command is waiting; the rest of the team can continue.',
    refs: [{ kind: 'task', taskId }],
  })
  const scoreApproval = approval('score-run', 'builder', 2000)
  const gap = {
    from: time(4000),
    to: time(5000),
    reason: 'Demo connection interrupted; this interval could not be recovered.',
  }
  const steps: ScenarioStep[] = [
    { at: 0, kind: 'system.status', data: { mode: 'fake', ...fakeStatus() } },
    ...agents.map((agent, index): ScenarioStep => ({
      at: 100 + index * 100,
      kind: 'agent.updated',
      data: agent,
    })),
    {
      at: 550,
      kind: 'room.upserted',
      data: {
        id: roomId,
        name: '#activity-feed',
        kind: 'room',
        leadAgentId: 'lead',
        members: agents.map((agent) => agent.id),
        unread: 0,
        activeAgents: [],
        channels: [],
      },
    },
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
        id: id('message-plan'),
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
        messageId: id('message-plan'),
        roomId,
        append: ' while keeping the newest activity visible.',
      },
    },
    { at: 1600, kind: 'message.completed', data: { messageId: id('message-plan'), roomId } },
    { at: 1700, kind: 'typing', data: { roomId, agentId: 'lead', text: null } },
    { at: 2000, kind: 'approval.requested', data: scoreApproval },
    {
      // Score-run approvals show up in the room as their own card message.
      at: 2050,
      kind: 'message.created',
      data: {
        id: `approval:${scoreApproval.id}`,
        roomId,
        author: { kind: 'agent', agentId: scoreApproval.agentId },
        to: [],
        parts: [{ kind: 'approval', approvalId: scoreApproval.id }],
        createdAt: time(2050),
        streaming: false,
        refs: [],
      },
    },
    { at: 2300, kind: 'approval.requested', data: approval('gateway', 'designer', 2300) },
    {
      at: 2500,
      kind: 'task.upserted',
      data: {
        ...task,
        column: 'needs_you',
        hermesStatus: 'blocked',
        badge: { kind: 'blocked', label: 'Blocked in unattended mode' },
        updatedAt: time(2500),
      },
    },
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
        id: id('log-check'),
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
          id: id('block-review'),
          label: 'Review pagination',
          start: time(6600),
          taskId: reviewTaskId,
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
          id: id('handoff-review'),
          from: { agentId: 'builder', blockId: `task:${taskId}` },
          to: { agentId: 'reviewer', blockId: `task:${reviewTaskId}` },
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
        elapsedSec: 180,
        updatedAt: time(10000),
      },
    },
  ]
  steps.push(
    {
      at: 1450,
      kind: 'message.delta',
      data: {
        messageId: id('message-plan'),
        roomId,
        append: ' Load older items in batches of 25.',
      },
    },
    {
      at: 1500,
      kind: 'message.delta',
      data: {
        messageId: id('message-plan'),
        roomId,
        append: ' Keep keyboard focus on the load button.',
      },
    },
    {
      at: 1800,
      kind: 'typing',
      data: { roomId, agentId: 'builder', text: 'is checking the dependency versions' },
    },
    { at: 3100, kind: 'typing', data: { roomId, agentId: 'builder', text: null } },
    {
      at: 3500,
      kind: 'log.line',
      data: {
        id: id('log-page'),
        at: time(3500),
        agentId: 'builder',
        kind: 'tool',
        text: 'Added the next-page cursor and loading state.',
      },
    },
    {
      at: 3600,
      kind: 'lane.upserted',
      data: {
        briefId,
        agentId: 'builder',
        block: { ...block, label: 'Check cursor and keyboard behavior' },
      },
    },
    {
      at: 3700,
      kind: 'task.upserted',
      data: { ...task, progress: 0.55, elapsedSec: 66, updatedAt: time(3700) },
    },
    {
      at: 3701,
      kind: 'approval.updated',
      data: { ...approval('kanban', 'reviewer', 2600), phase: 'withdrawn', status: 'withdrawn' },
    },
    {
      at: 4200,
      kind: 'agent.updated',
      data: {
        ...agents[1]!,
        status: 'working',
        activity: 'Checking cursor recovery after reconnect',
      },
    },
    {
      at: 4500,
      kind: 'log.line',
      data: {
        id: id('log-reconnect'),
        at: time(4500),
        agentId: 'builder',
        kind: 'system',
        text: 'Reconnecting to the feed; preserving the current page.',
      },
    },
    {
      at: 5800,
      kind: 'task.upserted',
      data: { ...task, progress: 0.85, elapsedSec: 104, updatedAt: time(5800) },
    },
    {
      at: 7200,
      kind: 'agent.updated',
      data: {
        ...agents[2]!,
        status: 'working',
        activity: 'Reviewing pagination and focus handling',
      },
    },
    {
      at: 7250,
      kind: 'typing',
      data: { roomId, agentId: 'reviewer', text: 'is writing the review' },
    },
    {
      at: 7300,
      kind: 'message.created',
      data: {
        id: id('message-review'),
        roomId,
        author: { kind: 'agent', agentId: 'reviewer' },
        to: ['builder'],
        parts: [{ kind: 'text', text: 'The cursor and loading states look good.' }],
        createdAt: time(7300),
        streaming: true,
        refs: [{ kind: 'task', taskId }],
      },
    },
    {
      at: 7400,
      kind: 'message.delta',
      data: {
        messageId: id('message-review'),
        roomId,
        append: ' Keyboard focus stays in place after loading.',
      },
    },
    {
      at: 7500,
      kind: 'message.delta',
      data: {
        messageId: id('message-review'),
        roomId,
        append: ' Ready to merge after the final checks.',
      },
    },
    { at: 7600, kind: 'message.completed', data: { messageId: id('message-review'), roomId } },
    { at: 7700, kind: 'typing', data: { roomId, agentId: 'reviewer', text: null } },
    {
      at: 7800,
      kind: 'log.line',
      data: {
        id: id('log-review'),
        at: time(7800),
        agentId: 'reviewer',
        kind: 'tool',
        text: 'Final checks passed: pagination, reconnect and keyboard focus.',
      },
    },
    {
      at: 9500,
      kind: 'lane.upserted',
      data: {
        briefId,
        agentId: 'reviewer',
        block: {
          ...block,
          id: id('block-review'),
          label: 'Review pagination',
          start: time(6600),
          end: time(9500),
          state: 'done',
          taskId: reviewTaskId,
          runId: null,
        },
      },
    },
    { at: 9800, kind: 'agent.updated', data: agents[2]! },
    // The review pass is a run of its own, so Now › Score draws the reviewer's lane from real run data.
    { at: 6650, kind: 'run.updated', data: { ...reviewRun, status: 'running' } },
    {
      at: 9500,
      kind: 'run.updated',
      data: { ...reviewRun, status: 'completed', endedAt: time(9500), toolsUsed: ['editor'] },
    },
  )
  // A second task keeps an actionable approval open for most of the loop, so the task drawer can be
  // exercised without racing the first approval's short life.
  const docsTaskId = id('task-docs')
  const docsTask = {
    id: docsTaskId,
    key: 'T-102',
    title: 'Publish the pagination notes',
    column: 'needs_you' as const,
    hermesStatus: 'running',
    assignee: 'designer',
    reviewer: 'reviewer',
    roomId,
    badge: { kind: 'needs_you' as const, label: 'Needs you' },
    progress: null,
    elapsedSec: 30,
    note: 'Wants to install a package',
    updatedAt: time(150),
  }
  const docsApproval: Approval = {
    id: id('approval-docs'),
    origin: 'score-run',
    phase: 'human_pending',
    status: 'pending',
    actionable: true,
    linkedTo: null,
    agentId: 'designer',
    title: 'May I install the docs generator?',
    command: 'pnpm add -D typedoc@0.28.0',
    cwd: 'demo-project',
    description: 'This command changes the workspace and needs your approval.',
    choices: ['once', 'session', 'always', 'deny'],
    createdAt: time(160),
    expiresAt: null,
    decision: null,
    delivery: 'none',
    blocking: 'Only this command is waiting; the rest of the team can continue.',
    refs: [{ kind: 'task', taskId: docsTaskId }],
  }
  // The brief: the person's ask, the lead's plan turn, the build task, and its review (with one round sent back).
  // The docs task above is not linked to it, so Flow leaves it out.
  const reviewTask = {
    ...task,
    id: reviewTaskId,
    key: 'T-103',
    title: 'Review pagination',
    assignee: 'reviewer',
    reviewer: null,
    column: 'working' as const,
    hermesStatus: 'running',
    progress: 0.3,
    note: null,
    updatedAt: time(6550),
  }
  const ask = 'Add pagination to the activity feed'
  steps.push(
    {
      at: 560,
      kind: 'message.created',
      data: {
        id: briefId,
        roomId,
        author: { kind: 'you' },
        to: ['lead'],
        parts: [{ kind: 'text', text: ask }],
        createdAt: time(560),
        streaming: false,
        refs: [],
      },
    },
    {
      at: 570,
      kind: 'brief.upserted',
      data: {
        id: briefId,
        title: ask,
        roomId,
        startedAt: time(570),
        startedBy: 'you',
        status: 'running',
      },
    },
    {
      at: 1650,
      kind: 'handoff.created',
      data: {
        briefId,
        handoff: {
          id: id('handoff-build'),
          from: { agentId: 'lead', blockId: `turn:${id('message-plan')}` },
          to: { agentId: 'builder', blockId: `task:${taskId}` },
          kind: 'handoff',
          at: time(1650),
        },
      },
    },
    { at: 6550, kind: 'task.upserted', data: reviewTask },
    {
      at: 7900,
      kind: 'handoff.created',
      data: {
        briefId,
        handoff: {
          id: id('handoff-sent-back'),
          from: { agentId: 'reviewer', blockId: `task:${reviewTaskId}` },
          to: { agentId: 'builder', blockId: `task:${taskId}` },
          kind: 'sent_back',
          at: time(7900),
        },
      },
    },
    {
      at: 7910,
      kind: 'task.upserted',
      data: { ...task, progress: 0.9, elapsedSec: 140, updatedAt: time(7910) },
    },
    {
      at: 9500,
      kind: 'task.upserted',
      data: {
        ...reviewTask,
        column: 'done',
        hermesStatus: 'done',
        progress: 1,
        elapsedSec: 52,
        updatedAt: time(9500),
      },
    },
  )
  steps.push(
    { at: 150, kind: 'task.upserted', data: docsTask },
    { at: 160, kind: 'approval.requested', data: docsApproval },
    {
      at: 170,
      kind: 'task.activity',
      data: {
        taskId: docsTaskId,
        item: { at: time(170), agentId: 'designer', text: 'Asked to install typedoc@0.28.0' },
      },
    },
    {
      at: 9750,
      kind: 'approval.updated',
      data: { ...docsApproval, phase: 'withdrawn', status: 'withdrawn' },
    },
  )
  return steps
    .sort((left, right) => left.at - right.at)
    .map((step) => ({ ...step, at: step.at * 18 }))
}
