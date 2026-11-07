import type { Approval } from '@score/contract'
import { exampleAgents, exampleRun } from './scenario-fixtures.ts'

export function createScenarioContext(startedAt: number, loop = 0) {
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
    kind: 'task' as const,
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

  return {
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
    reviewRun,
    approval,
    scoreApproval,
    gap,
  }
}

export type ScenarioContext = ReturnType<typeof createScenarioContext>
