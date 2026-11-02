import type { TaskColumn, TaskSummary } from '@score/contract'
import { durationText } from '../live/run-summary.ts'
import { blockedTask } from './room/task-queries.ts'

// 3.16.0: the Tasks board's pure parts. The server decides a task's column; the board only moves a blocked task into
// Needs you (a blocked badge is a decision of the person's even when Hermes still lists the task as working).

export const BOARD_COLUMNS: { id: TaskColumn; title: string }[] = [
  { id: 'planned', title: 'Planned' },
  { id: 'working', title: 'Working' },
  { id: 'in_review', title: 'In review' },
  { id: 'needs_you', title: 'Needs you' },
  { id: 'done', title: 'Done' },
]

/** Done lists this many newest tasks until "Show older". */
export const DONE_LIMIT = 20

export function boardColumn(task: TaskSummary): TaskColumn {
  return task.column !== 'done' && blockedTask(task) ? 'needs_you' : task.column
}

export type TaskFilter = { agent: string | null; room: string | null }

const newestFirst = (a: TaskSummary, b: TaskSummary) =>
  b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)

export function filterTasks(tasks: TaskSummary[], filter: TaskFilter): TaskSummary[] {
  return tasks.filter(
    (task) =>
      (filter.agent === null || task.assignee === filter.agent) &&
      (filter.room === null || task.roomId === filter.room),
  )
}

export function groupTasks(tasks: TaskSummary[]): Record<TaskColumn, TaskSummary[]> {
  const columns: Record<TaskColumn, TaskSummary[]> = {
    planned: [],
    working: [],
    in_review: [],
    needs_you: [],
    done: [],
  }
  for (const task of [...tasks].sort(newestFirst)) columns[boardColumn(task)].push(task)
  return columns
}

/** The room filter appears only when the tasks span two or more rooms; a task with no room is not a room. */
export function roomChoices(tasks: TaskSummary[]): string[] {
  const rooms = new Set<string>()
  for (const task of tasks) if (task.roomId) rooms.add(task.roomId)
  return rooms.size >= 2 ? [...rooms] : []
}

export function elapsedLabel(task: TaskSummary): string {
  if (task.elapsedSec !== null && task.elapsedSec > 0) return durationText(task.elapsedSec)
  return task.column === 'planned' ? 'queued' : ''
}

export function progressPercent(task: TaskSummary): number | null {
  return task.progress === null ? null : Math.round(Math.min(1, Math.max(0, task.progress)) * 100)
}
