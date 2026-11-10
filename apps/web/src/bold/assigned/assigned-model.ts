import type { AgentAssigned, TaskColumn, TaskSummary } from '@score/contract'
import { boardColumn } from '../bold-tasks-model.ts'

// TR.4: the pure parts of "Assigned": which tasks count, the words for a task's state and the counts and names the
// agent page's line and the direct chat's Info show. Schedules are shown as stored: no schedule-words formatter exists
// yet (TR.2 would write one).

/** The task states in the mock-up's words (the Tasks board says Planned and Working). */
const TASK_STATE_WORDS: Partial<Record<TaskColumn, string>> = {
  planned: 'to do',
  working: 'in progress',
  in_review: 'in review',
  needs_you: 'needs you',
}

/** An agent's tasks that are not done, newest first. Done tasks are history, not assignments. */
export function assignedTasks(tasks: TaskSummary[], agentId: string): TaskSummary[] {
  return tasks
    .filter((task) => task.assignee === agentId && task.column !== 'done')
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
}

export function taskStateWords(task: TaskSummary): string {
  return TASK_STATE_WORDS[boardColumn(task)] ?? 'to do'
}

/** Repeating jobs and recipe steps count together as "repeating"; tasks are counted on their own. */
export function assignedCounts(assigned: AgentAssigned, tasks: TaskSummary[]) {
  return {
    repeating: assigned.repeating.length + assigned.recipeSteps.length,
    tasks: tasks.length,
  }
}

/** The names on the agent page's line: job titles, then recipe steps as "Recipe (step name)". */
export function assignedNames(assigned: AgentAssigned): string[] {
  return [
    ...assigned.repeating.map((job) => job.title),
    ...assigned.recipeSteps.map((step) => `${step.recipeName} (${step.stepLabel})`),
  ]
}

/** "next in 14 h" from a fire time; null when Hermes gave none. */
export function nextInText(iso: string | null, now: number): string | null {
  if (!iso) return null
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return null
  const minutes = Math.round((at - now) / 60_000)
  if (minutes < 1) return 'next run due'
  if (minutes < 60) return `next in ${minutes} min`
  if (minutes < 48 * 60) return `next in ${Math.round(minutes / 60)} h`
  return `next in ${Math.round(minutes / (24 * 60))} d`
}
