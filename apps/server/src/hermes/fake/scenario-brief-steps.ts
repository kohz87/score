import type { ScenarioContext } from './scenario-context.ts'
import type { ScenarioStep } from './scenario-types.ts'

export function createBriefScenarioSteps(context: ScenarioContext): ScenarioStep[] {
  const { id, time, taskId, roomId, briefId, reviewTaskId, task } = context
  // The brief: the person's ask, the lead's plan turn, the build task, and its review (with one round sent back).
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

  return [
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
  ]
}
