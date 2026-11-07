import type { ScenarioContext } from './scenario-context.ts'
import { fakeStatus } from './scenario-fixtures.ts'
import type { ScenarioStep } from './scenario-types.ts'

export function createMainScenarioSteps(context: ScenarioContext): ScenarioStep[] {
  const {
    id,
    time,
    agents,
    taskId,
    roomId,
    briefId,
    reviewTaskId,
    run,
    task,
    block,
    approval,
    scoreApproval,
    gap,
  } = context

  return [
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
    {
      at: 3801,
      kind: 'message.created',
      data: {
        id: id('message-build-files'),
        roomId,
        author: { kind: 'agent', agentId: 'builder' },
        to: [],
        parts: [
          { kind: 'tools', summary: 'Edited 2 files', runId: run.id },
          { kind: 'file', path: 'src/activity-feed.ts', added: 24, removed: 3 },
          { kind: 'file', path: 'src/feed-card.css', added: 12, removed: 2 },
        ],
        createdAt: time(3801),
        streaming: false,
        refs: [{ kind: 'run', runId: run.id }],
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
        toolsUsed: ['terminal', 'edit_file'],
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
}
