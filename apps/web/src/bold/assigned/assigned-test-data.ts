import type { AgentAssigned, RepeatingJob, TaskColumn, TaskSummary } from '@score/contract'

// Fixtures for the Assigned tests (TR.4): jobs, recipe steps and tasks set to the agent `builder`.

/** An ISO time `hours` from now (plus a minute, so the rounded text is stable). */
export const inHours = (hours: number) =>
  new Date(Date.now() + hours * 3_600_000 + 60_000).toISOString()

export function repeatingJob(
  overrides: Partial<RepeatingJob> & Pick<RepeatingJob, 'id' | 'title'>,
): RepeatingJob {
  return {
    agentId: 'builder',
    schedule: '0 8 * * *',
    description: '',
    lastRunAt: null,
    enabled: true,
    model: null,
    nextRunAt: null,
    provider: null,
    deliverTo: null,
    ...overrides,
  }
}

export function task(
  overrides: Partial<TaskSummary> & Pick<TaskSummary, 'id' | 'title' | 'column'>,
): TaskSummary {
  return {
    key: `T-${overrides.id}`,
    hermesStatus: 'running',
    assignee: 'builder',
    reviewer: null,
    roomId: null,
    badge: null,
    progress: null,
    elapsedSec: null,
    note: null,
    updatedAt: '2026-11-10T09:00:00.000Z',
    ...overrides,
  }
}

/** `GET /api/tasks`: every column present, the tasks grouped by their column. */
export function snapshot(tasks: TaskSummary[]) {
  const columns: Record<TaskColumn, TaskSummary[]> = {
    planned: [],
    working: [],
    in_review: [],
    needs_you: [],
    done: [],
  }
  for (const item of tasks) columns[item.column].push(item)
  return { asOfSeq: 1, columns }
}

export function assignedFixture(overrides: Partial<AgentAssigned> = {}): AgentAssigned {
  return {
    agentId: 'builder',
    repeating: [],
    recipeSteps: [],
    ...overrides,
  }
}
