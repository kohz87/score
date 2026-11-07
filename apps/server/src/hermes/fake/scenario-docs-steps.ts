import type { Approval } from '@score/contract'
import type { ScenarioContext } from './scenario-context.ts'
import type { ScenarioStep } from './scenario-types.ts'

export function createDocsScenarioSteps(context: ScenarioContext): ScenarioStep[] {
  const { id, time, roomId } = context
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
    updatedAt: time(552),
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
    createdAt: time(553),
    expiresAt: null,
    decision: null,
    delivery: 'none',
    blocking: 'Only this command is waiting; the rest of the team can continue.',
    refs: [{ kind: 'task', taskId: docsTaskId }],
  }

  return [
    // After the room exists (550): a task never points at a room the API doesn't list yet.
    { at: 552, kind: 'task.upserted', data: docsTask },
    { at: 553, kind: 'approval.requested', data: docsApproval },
    {
      at: 554,
      kind: 'task.activity',
      data: {
        taskId: docsTaskId,
        item: { at: time(554), agentId: 'designer', text: 'Asked to install typedoc@0.28.0' },
      },
    },
    {
      at: 9750,
      kind: 'approval.updated',
      data: { ...docsApproval, phase: 'withdrawn', status: 'withdrawn' },
    },
  ]
}
