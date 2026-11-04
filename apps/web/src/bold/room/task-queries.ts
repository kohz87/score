import {
  TaskDetailSchema,
  TasksSnapshotSchema,
  TaskSummarySchema,
  type TaskColumn,
  type TaskCreateRequest,
  type TaskDetail,
  type TaskPatchRequest,
  type TaskSummary,
} from '@score/contract'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '../../data/api.ts'
import { newId } from '../../data/ids.ts'
import { defineStreamQuery } from '../../data/resync.ts'

export type RoomTasks = { asOfSeq: number; tasks: TaskSummary[] }

function flatten(columns: Record<TaskColumn, TaskSummary[]>): TaskSummary[] {
  return Object.values(columns).flat()
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
      const response = TasksSnapshotSchema.parse(await apiFetch(`tasks?${query}`, { signal }))
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

export type TaskActionName =
  'unblock' | 'comment' | 'start' | 'block' | 'request_review' | 'complete' | 'archive'

export function taskAction(taskId: string, action: TaskActionName, text?: string, key = newId()) {
  return apiFetch(`tasks/${encodeURIComponent(taskId)}/actions`, {
    method: 'POST',
    headers: { 'Idempotency-Key': key },
    body: JSON.stringify({ action, ...(text?.trim() ? { text: text.trim() } : {}) }),
  })
}

/** 3.27.0: `POST /api/tasks`. The key is the caller's, kept across retries so a retry never makes a second task. */
export async function createTask(
  request: TaskCreateRequest,
  key: string,
): Promise<TaskDetail & { startFailed?: boolean }> {
  const answer: unknown = await apiFetch('tasks', {
    method: 'POST',
    headers: { 'Idempotency-Key': key },
    body: JSON.stringify(request),
  })
  // The task was made even when starting it failed (the server says `startFailed`): it waits in Planned.
  const startFailed =
    typeof answer === 'object' &&
    answer !== null &&
    (answer as { startFailed?: unknown }).startFailed === true
  return { ...TaskDetailSchema.parse(answer), ...(startFailed ? { startFailed } : {}) }
}

/** 3.27.0: `PATCH /api/tasks/:taskId` with only what changed. */
export async function patchTask(taskId: string, request: TaskPatchRequest): Promise<TaskDetail> {
  return TaskDetailSchema.parse(
    await apiFetch(`tasks/${encodeURIComponent(taskId)}`, {
      method: 'PATCH',
      body: JSON.stringify(request),
    }),
  )
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

export type AllTasks = { asOfSeq: number; tasks: TaskSummary[] }

/** Every Hermes task across rooms (the Tasks board, 3.16.0), newest change first, kept live by `task.upserted`. */
export const allTasksQuery = defineStreamQuery<AllTasks>({
  key: ['bold', 'tasks', 'all'],
  async fetch(signal) {
    const response = TasksSnapshotSchema.parse(await apiFetch('tasks', { signal }))
    return {
      asOfSeq: response.asOfSeq,
      data: { asOfSeq: response.asOfSeq, tasks: flatten(response.columns) },
    }
  },
  types: ['task.upserted'],
  reduce(data, event) {
    if (event.type !== 'task.upserted') return data
    const task = TaskSummarySchema.parse(event.data)
    return {
      ...data,
      tasks: [...data.tasks.filter((item) => item.id !== task.id), task],
    }
  },
})
