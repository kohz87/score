// Synthetic traffic for the load test: one "cycle" is a run with its streamed reply, task updates, a
// watch frame or two and sometimes an approval. Cycles interleave; steps inside a cycle stay in order.
import type { ScenarioStep } from '../apps/server/src/hermes/fake/scenario.ts'

type Data<K extends ScenarioStep['kind']> = Extract<ScenarioStep, { kind: K }>['data']

export const LOAD_ROOMS = ['room-load-0', 'room-load-1', 'room-load-2', 'room-load-3']
const AGENTS = ['lead', 'builder', 'reviewer', 'designer']
const DELTAS = 12

export function roomSteps(): ScenarioStep[] {
  return LOAD_ROOMS.map((id, index): ScenarioStep => ({
    at: 0,
    kind: 'room.upserted',
    data: {
      id,
      name: `#load-${index}`,
      kind: 'room',
      leadAgentId: 'lead',
      members: AGENTS,
      unread: 0,
      activeAgents: [],
      channels: [],
    },
  }))
}

export function cycleSteps(n: number, now: () => string): ScenarioStep[] {
  const agentId = AGENTS[n % AGENTS.length]!
  const roomId = LOAD_ROOMS[n % LOAD_ROOMS.length]!
  const taskId = `task-load-${n}`
  const messageId = `message-load-${n}`
  const runId = `run-load-${n}`
  const started = now()
  const run: Data<'run.updated'> = {
    id: runId,
    agentId,
    origin: 'score',
    status: 'queued',
    startedAt: started,
    endedAt: null,
    model: 'fake-model',
    toolsUsed: [],
    tokens: null,
    costUsd: null,
    refs: [{ kind: 'task', taskId }],
    gaps: [],
  }
  const task = {
    id: taskId,
    key: `L-${n}`,
    title: `Load task ${n}`,
    column: 'working' as const,
    hermesStatus: 'running',
    assignee: agentId,
    reviewer: 'reviewer',
    roomId,
    badge: null,
    progress: 0.1,
    elapsedSec: 0,
    note: 'Synthetic load',
    updatedAt: started,
  }
  const steps: ScenarioStep[] = []
  const add = (step: Omit<ScenarioStep, 'at'>) => steps.push({ ...step, at: 0 } as ScenarioStep)
  add({ kind: 'run.updated', data: run })
  add({ kind: 'task.upserted', data: task })
  add({ kind: 'run.updated', data: { ...run, status: 'running' } })
  add({
    kind: 'message.created',
    data: {
      id: messageId,
      roomId,
      author: { kind: 'agent', agentId },
      to: [],
      parts: [{ kind: 'text', text: `Working on load task ${n}.` }],
      createdAt: started,
      streaming: true,
      refs: [{ kind: 'task', taskId }],
    },
  })
  for (let i = 0; i < DELTAS; i += 1) {
    add({
      kind: 'message.delta',
      data: { messageId, roomId, append: ` step ${i} of the reply for task ${n}.` },
    })
    if (i === 3)
      add({
        kind: 'log.line',
        data: {
          id: `log-load-${n}-a`,
          at: now(),
          agentId,
          kind: 'tool',
          text: `Ran check ${n}: ${i} passed.`,
        },
      })
    if (i === 5)
      add({
        kind: 'watch.frame',
        data: {
          seq: n * 10 + 1,
          at: now(),
          agentId,
          runId,
          surface: 'terminal',
          terminal: {
            cwd: 'demo-project',
            command: `pnpm test -- load-${n}`,
            output: `${'ok line of output\n'.repeat(20)}done`,
            status: 'ok',
          },
          caption: `Checked load task ${n}`,
        },
      })
    if (i === 7)
      add({
        kind: 'task.upserted',
        data: { ...task, progress: 0.5, elapsedSec: 30, updatedAt: now() },
      })
    if (i === 9)
      add({
        kind: 'watch.frame',
        data: {
          seq: n * 10 + 2,
          at: now(),
          agentId,
          runId,
          surface: 'editor',
          editor: {
            path: `src/load-${n}.ts`,
            diff: `+ export const value${n} = ${n}\n- export const value${n} = 0`,
            language: 'typescript',
          },
          caption: `Edited load-${n}.ts`,
        },
      })
  }
  if (n % 5 === 0) {
    const approval: Data<'approval.requested'> = {
      id: `approval-load-${n}`,
      origin: 'score-run',
      phase: 'human_pending',
      status: 'pending',
      actionable: true,
      linkedTo: null,
      agentId,
      title: 'May I run the checks?',
      command: `pnpm test -- load-${n}`,
      cwd: 'demo-project',
      description: 'Synthetic approval for the load test.',
      choices: ['once', 'session', 'always', 'deny'],
      createdAt: now(),
      expiresAt: null,
      decision: null,
      delivery: 'none',
      blocking: 'Only this command is waiting.',
      refs: [{ kind: 'task', taskId }],
    }
    add({ kind: 'approval.requested', data: approval })
    add({
      kind: 'approval.updated',
      data: {
        ...approval,
        phase: 'decided',
        status: 'approved',
        decision: { choice: 'once', by: 'elsewhere', at: now() },
        delivery: 'applied',
      },
    })
  }
  add({
    kind: 'task.activity',
    data: { taskId, item: { at: now(), agentId, text: `Finished load task ${n}.` } },
  })
  add({ kind: 'message.completed', data: { messageId, roomId } })
  add({
    kind: 'task.upserted',
    data: { ...task, column: 'in_review', progress: 1, elapsedSec: 60, updatedAt: now() },
  })
  add({
    kind: 'run.updated',
    data: { ...run, status: 'completed', endedAt: now(), toolsUsed: ['terminal'] },
  })
  return steps
}
