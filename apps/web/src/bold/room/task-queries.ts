import {
  TaskColumnSchema,
  TaskDetailSchema,
  TaskSummarySchema,
  type TaskColumn,
  type TaskDetail,
  type TaskSummary,
} from '@score/contract'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '../../data/api.ts'
import { newId } from '../../data/ids.ts'
import { defineStreamQuery } from '../../data/resync.ts'

// The contract documents GET /api/tasks but has no exported envelope schema; this is the shape the server returns.
function parseTaskList(value: unknown): {
  asOfSeq: number
  columns: Record<TaskColumn, TaskSummary[]>
} {
  if (typeof value !== 'object' || value === null)
    throw new Error('The task list is not an object.')
  const asOfSeq = (value as { asOfSeq?: unknown }).asOfSeq
  const columns = (value as { columns?: unknown }).columns
  if (typeof asOfSeq !== 'number' || !Number.isInteger(asOfSeq) || asOfSeq < 0)
    throw new Error('The task list has no sequence.')
  if (typeof columns !== 'object' || columns === null)
    throw new Error('The task list has no columns.')
  return {
    asOfSeq,
    columns: Object.fromEntries(
      TaskColumnSchema.options.map((column) => [
        column,
        TaskSummarySchema.array().parse((columns as Record<string, unknown>)[column] ?? []),
      ]),
    ) as Record<TaskColumn, TaskSummary[]>,
  }
}

export type RoomTasks = { asOfSeq: number; tasks: TaskSummary[] }

function flatten(columns: Record<TaskColumn, TaskSummary[]>): TaskSummary[] {
  return TaskColumnSchema.options.flatMap((column) => columns[column] ?? [])
}

/**
 * The room's Hermes tasks, or its blocked ones. The server's `room` filter cannot include tasks with no room, so the
 * needs-you read asks for every blocked task and keeps this room's plus (in the team room) the unassigned ones here.
 */
export function roomTasksQuery(roomId: string, includeUnassigned: boolean, needsYou = false) {
  return defineStreamQuery<RoomTasks>({
    key: ['bold', 'tasks', roomId, includeUnassigned, needsYou],
    async fetch(signal) {
      const query = new URLSearchParams(needsYou ? { needsYou: 'true' } : { room: roomId })
      const response = parseTaskList(await apiFetch(`tasks?${query}`, { signal }))
      return {
        asOfSeq: response.asOfSeq,
        data: {
          asOfSeq: response.asOfSeq,
          tasks: flatten(response.columns).filter(
            (task) => task.roomId === roomId || (includeUnassigned && task.roomId === null),
          ),
        },
      }
    },
    types: ['task.upserted'],
    reduce(data, event) {
      if (event.type !== 'task.upserted') return data
      const task = TaskSummarySchema.parse(event.data)
      const belongs =
        (task.roomId === roomId || (includeUnassigned && task.roomId === null)) &&
        (!needsYou || blockedTask(task))
      return {
        ...data,
        tasks: [
          ...data.tasks.filter((item) => item.id !== task.id),
          ...(belongs ? [task] : []),
        ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)),
      }
    },
  })
}

export const taskDetailKey = (taskId: string) => ['bold', 'task', taskId] as const

export function useTaskDetail(taskId: string | null) {
  return useQuery({
    queryKey: taskDetailKey(taskId ?? ''),
    queryFn: async ({ signal }): Promise<TaskDetail> =>
      TaskDetailSchema.parse(await apiFetch(`tasks/${encodeURIComponent(taskId!)}`, { signal })),
    enabled: taskId !== null,
    retry: false,
  })
}

export function taskAction(
  taskId: string,
  action: 'unblock' | 'comment',
  text?: string,
  key = newId(),
) {
  return apiFetch(`tasks/${encodeURIComponent(taskId)}/actions`, {
    method: 'POST',
    headers: { 'Idempotency-Key': key },
    body: JSON.stringify({ action, ...(text?.trim() ? { text: text.trim() } : {}) }),
  })
}

export function useTaskRefresh() {
  const queryClient = useQueryClient()
  return () => {
    void queryClient.invalidateQueries({ queryKey: ['bold', 'tasks'] })
    void queryClient.invalidateQueries({ queryKey: ['bold', 'task'] })
  }
}

export function blockedTask(task: TaskSummary): boolean {
  return task.column === 'needs_you' || task.badge?.kind === 'blocked'
}

export function taskStateLabel(task: TaskSummary): string {
  if (task.badge?.kind === 'blocked' || task.column === 'needs_you') return 'Blocked'
  if (task.column === 'in_review') return 'In review'
  if (task.column === 'planned') return 'Planned'
  if (task.column === 'done') return 'Done'
  return 'Working'
}

export function taskBlockedReason(task: TaskSummary): string {
  return task.badge?.label ?? task.note ?? 'This task needs you before it can go on.'
}
