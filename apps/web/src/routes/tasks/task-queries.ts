import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import {
  AgentSummarySchema,
  RoomSchema,
  AsOfSeqSchema,
  TaskDetailSchema,
  TaskSummarySchema,
  type TaskColumn,
  type TaskDetail,
  type TaskSummary,
} from '@score/contract'
import { apiFetch } from '../../data/api.ts'
import { useStream } from '../../data/query-client.ts'
import { defineStreamQuery } from '../../data/resync.ts'

export const taskColumns: { id: TaskColumn; label: string }[] = [
  { id: 'planned', label: 'Planned' },
  { id: 'working', label: 'Working' },
  { id: 'in_review', label: 'In review' },
  { id: 'needs_you', label: 'Needs you' },
  { id: 'done', label: 'Done' },
]

export type TaskFilters = { agent: string; room: string; needsYou: boolean }
export type TaskBoard = {
  columns: Record<TaskColumn, TaskSummary[]>
  announcement: string
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new TypeError('Invalid snapshot response')
  return value as Record<string, unknown>
}

// A fresh server reports asOfSeq 0, which the stream's (positive) seq would reject.
function snapshot(value: unknown) {
  const fields = record(value)
  return { fields, asOfSeq: AsOfSeqSchema.parse(fields.asOfSeq) }
}

export function matchesFilters(task: TaskSummary, filters: TaskFilters) {
  return (
    task.hermesStatus !== 'archived' &&
    (!filters.agent || task.assignee === filters.agent) &&
    (!filters.room || task.roomId === filters.room) &&
    (!filters.needsYou || task.column === 'needs_you')
  )
}

export function tasksQuery(filters: TaskFilters) {
  return defineStreamQuery<TaskBoard>({
    key: ['tasks', 'board', filters],
    async fetch(signal) {
      const params = new URLSearchParams()
      if (filters.agent) params.set('agent', filters.agent)
      if (filters.room) params.set('room', filters.room)
      if (filters.needsYou) params.set('needsYou', 'true')
      const { fields, asOfSeq } = snapshot(
        await apiFetch(`tasks${params.size ? `?${params}` : ''}`, { signal }),
      )
      const rawColumns = record(fields.columns)
      const columns = Object.fromEntries(
        taskColumns.map(({ id }) => {
          const tasks = TaskSummarySchema.array().parse(rawColumns[id])
          if (tasks.some((task) => task.column !== id))
            throw new TypeError('Task is in the wrong column')
          return [id, tasks.filter((task) => matchesFilters(task, filters))]
        }),
      ) as TaskBoard['columns']
      return { asOfSeq, data: { columns, announcement: '' } }
    },
    types: ['task.upserted'],
    reduce(board, event) {
      if (event.type !== 'task.upserted') return board
      const task = event.data
      const visible = matchesFilters(task, filters)
      const existed = taskColumns.some(({ id }) =>
        board.columns[id].some((item) => item.id === task.id),
      )
      const columns = Object.fromEntries(
        taskColumns.map(({ id }) => {
          const previous = board.columns[id]
          const index = previous.findIndex((item) => item.id === task.id)
          const items = previous.filter((item) => item.id !== task.id)
          if (visible && id === task.column) items.splice(index < 0 ? 0 : index, 0, task)
          return [id, items]
        }),
      ) as TaskBoard['columns']
      return {
        columns,
        announcement: visible
          ? `${task.title} updated in ${taskColumns.find(({ id }) => id === task.column)!.label}.`
          : existed
            ? `${task.title} no longer matches these filters.`
            : board.announcement,
      }
    },
  })
}

export const taskAgentsQuery = defineStreamQuery({
  key: ['tasks', 'agents'],
  async fetch(signal) {
    const { fields, asOfSeq } = snapshot(await apiFetch('agents', { signal }))
    return { asOfSeq, data: AgentSummarySchema.array().parse(fields.items) }
  },
  types: ['agent.updated'],
  reduce(agents, event) {
    if (event.type !== 'agent.updated') return agents
    return agents.some((agent) => agent.id === event.data.id)
      ? agents.map((agent) => (agent.id === event.data.id ? event.data : agent))
      : [...agents, event.data]
  },
})

export const taskRoomsQuery = defineStreamQuery({
  key: ['tasks', 'rooms'],
  async fetch(signal) {
    const { fields, asOfSeq } = snapshot(await apiFetch('rooms', { signal }))
    return {
      asOfSeq,
      data: [
        ...RoomSchema.array().parse(fields.rooms),
        ...RoomSchema.array().parse(fields.directs),
      ],
    }
  },
  types: ['room.upserted'],
  reduce(rooms, event) {
    if (event.type !== 'room.upserted') return rooms
    return rooms.some((room) => room.id === event.data.id)
      ? rooms.map((room) => (room.id === event.data.id ? event.data : room))
      : [...rooms, event.data]
  },
})

export const taskDetailKey = (taskId: string) => ['tasks', 'detail', taskId] as const

// Details are not a snapshot endpoint, so (like the Team page) the cache is refetched when the stream says
// this task, its activity or one of its approvals changed, and after any reset.
export function useTaskDetail(taskId: string) {
  const stream = useStream()
  const queryClient = useQueryClient()
  useEffect(() => {
    const refresh = () => {
      void queryClient.invalidateQueries({ queryKey: taskDetailKey(taskId), exact: true })
    }
    const offEvent = stream.subscribe((event) => {
      if (
        (event.type === 'task.upserted' && event.data.id === taskId) ||
        (event.type === 'task.activity' && event.data.taskId === taskId) ||
        (event.type === 'attempt.updated' && event.data.taskId === taskId) ||
        ((event.type === 'approval.requested' || event.type === 'approval.updated') &&
          (event.data.refs.some((ref) => ref.kind === 'task' && ref.taskId === taskId) ||
            queryClient.getQueryData<TaskDetail>(taskDetailKey(taskId))?.pendingApproval?.id ===
              event.data.id))
      )
        refresh()
    })
    const offControl = stream.onControl(({ resync }) => {
      if (resync) refresh()
    })
    return () => {
      offEvent()
      offControl()
    }
  }, [stream, queryClient, taskId])
  return useQuery({
    queryKey: taskDetailKey(taskId),
    queryFn: async ({ signal }) =>
      TaskDetailSchema.parse(await apiFetch(`tasks/${encodeURIComponent(taskId)}`, { signal })),
    retry: false,
  })
}
