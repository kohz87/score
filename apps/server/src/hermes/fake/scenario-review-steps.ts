import type { ScenarioContext } from './scenario-context.ts'
import type { ScenarioStep } from './scenario-types.ts'

export function createReviewScenarioSteps(context: ScenarioContext): ScenarioStep[] {
  const {
    id,
    time,
    agents,
    taskId,
    roomId,
    briefId,
    reviewTaskId,
    task,
    block,
    reviewRun,
    approval,
  } = context

  return [
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
  ]
}
