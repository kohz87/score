import {
  AgentSubagentsSchema,
  JobSchema,
  SubagentRowSchema,
  SubagentRowsResponseSchema,
  type AgentId,
  type AgentSubagents,
  type AgentSubagentsRequest,
  type Job,
  type JobSubagentsRequest,
  type SubagentRow,
  type SubagentRowsResponse,
} from '@score/contract'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '../../data/api.ts'
import { defineStreamQuery } from '../../data/resync.ts'
import { useStreamQuery } from '../../data/query-client.ts'
import { changeCachedJob } from '../room/room-queries.ts'

const EMPTY: SubagentRowsResponse = { asOfSeq: 0, items: [] }

const mergeRows = (items: readonly SubagentRow[], row: SubagentRow): SubagentRow[] => [
  ...items.filter((item) => item.id !== row.id),
  row,
]

const rowOf = (value: unknown): SubagentRow => SubagentRowSchema.parse(value)

/** One job's subagent rows, kept live by `subagent.upserted` (its steps stay in Watch). */
export function jobSubagentRowsQuery(jobId: string | null) {
  return defineStreamQuery<SubagentRowsResponse>({
    key: ['bold', 'subagents', jobId],
    async fetch(signal) {
      if (jobId === null) return { asOfSeq: 0, data: EMPTY }
      const response = SubagentRowsResponseSchema.parse(
        await apiFetch(`jobs/${encodeURIComponent(jobId)}/subagents`, { signal }),
      )
      return { asOfSeq: response.asOfSeq, data: response }
    },
    types: ['subagent.upserted', 'job.deleted'],
    reduce(data, event) {
      if (jobId === null) return data
      if (event.type === 'job.deleted')
        return event.data.id === jobId ? { ...data, items: [] } : data
      if (event.type !== 'subagent.upserted') return data
      const row = rowOf(event.data)
      return row.jobId === jobId ? { ...data, items: mergeRows(data.items, row) } : data
    },
  })
}

export function useJobSubagentRows(jobId: string | null) {
  return useStreamQuery(jobSubagentRowsQuery(jobId)).data?.items ?? []
}

/** Several jobs' rows in one registration: the conversation shows a card wherever its job is on screen. */
export function roomSubagentRowsQuery(jobIds: readonly string[]) {
  const ids = [...new Set(jobIds)].sort()
  return defineStreamQuery<SubagentRow[]>({
    key: ['bold', 'subagents', 'room', ...ids],
    async fetch(signal) {
      const reads = await Promise.all(
        ids.map(async (jobId) =>
          SubagentRowsResponseSchema.parse(
            await apiFetch(`jobs/${encodeURIComponent(jobId)}/subagents`, { signal }),
          ),
        ),
      )
      return {
        asOfSeq: reads.reduce((highest, read) => Math.max(highest, read.asOfSeq), 0),
        data: reads.flatMap((read) => read.items),
      }
    },
    types: ['subagent.upserted', 'job.deleted'],
    reduce(data, event) {
      if (event.type === 'job.deleted')
        return data.filter((row) => row.jobId !== event.data.id)
      if (event.type !== 'subagent.upserted') return data
      const row = rowOf(event.data)
      return ids.includes(row.jobId) ? mergeRows(data, row) : data
    },
  })
}

export function useRoomSubagentRows(jobIds: readonly string[]) {
  return useStreamQuery(roomSubagentRowsQuery(jobIds)).data ?? []
}

/** The agent's ceiling; null at once means the job's own limit is the one that applies. */
export function agentSubagentsQuery(agentId: AgentId | null, enabled = true) {
  return {
    queryKey: ['bold', 'agent-subagents', agentId] as const,
    enabled: Boolean(agentId) && enabled,
    staleTime: 60_000,
    retry: false,
    queryFn: async ({ signal }: { signal: AbortSignal }): Promise<AgentSubagents> =>
      AgentSubagentsSchema.parse(
        await apiFetch(`agents/${encodeURIComponent(agentId!)}/subagents`, { signal }),
      ),
  }
}

export function useAgentSubagents(agentId: AgentId | null, enabled = true) {
  return useQuery(agentSubagentsQuery(agentId, enabled))
}

export async function putJobSubagents(
  jobId: string,
  body: JobSubagentsRequest,
): Promise<Job> {
  return JobSchema.parse(
    await apiFetch(`jobs/${encodeURIComponent(jobId)}/subagents`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  )
}

export function useSetJobSubagents(jobId: string | null) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (body: JobSubagentsRequest): Promise<Job> => {
      if (!jobId) throw new Error('There is no job to change.')
      return putJobSubagents(jobId, body)
    },
    onSuccess: (job) => changeCachedJob(queryClient, job, 'upsert'),
  })
}

export async function putAgentSubagents(
  agentId: string,
  body: AgentSubagentsRequest,
): Promise<AgentSubagents> {
  return AgentSubagentsSchema.parse(
    await apiFetch(`agents/${encodeURIComponent(agentId)}/subagents`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  )
}

