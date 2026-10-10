import {
  ValidationResultSchema,
  WorkflowDetailSchema,
  WorkflowExportSchema,
  WorkflowListSchema,
  WorkflowPreflightSchema,
  WorkflowRunCreatedSchema,
  WorkflowRunEventsSchema,
  WorkflowRunListSchema,
  WorkflowRunSnapshotSchema,
  WorkflowRunSummarySchema,
  WorkflowVersionSchema,
  type GateDecision,
  type LimitsDecision,
  type RunControl,
  type WaiverDecision,
  type AbandonDecision,
  type WorkflowDefinition,
  type WorkflowEvent,
  type WorkflowRemapDecision,
  type WorkflowRetryDecision,
  type WorkflowRunCreate,
  type WorkflowRunDetail,
  type WorkflowRunSummary,
  type WorkflowTryAgainDecision,
} from '@score/contract'
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { apiFetch } from '../../data/api.ts'
import { newId } from '../../data/ids.ts'
import { defineStreamQuery } from '../../data/resync.ts'
import { useLiveRun, post } from '../orchestrations/orchestration-queries.ts'

// Definitions are plain reads and paired writes (no stream event announces them); runs arrive on the stream as
// `workflow.run.upserted` summaries and are read in full on demand, like orchestrations.

export const workflowsKey = ['workflows', 'list'] as const
export const workflowKey = (id: string) => ['workflows', 'detail', id] as const

export function useWorkflows() {
  return useQuery({
    queryKey: workflowsKey,
    queryFn: async ({ signal }) =>
      WorkflowListSchema.parse(await apiFetch('workflows', { signal })),
    retry: false,
  })
}

export function useWorkflow(id: string | undefined) {
  return useQuery({
    queryKey: workflowKey(id ?? ''),
    enabled: id !== undefined,
    queryFn: async ({ signal }) =>
      WorkflowDetailSchema.parse(
        await apiFetch(`workflows/${encodeURIComponent(id!)}`, { signal }),
      ),
    retry: false,
  })
}

const versionQuery = (id: string | undefined, version: number | undefined) => ({
  queryKey: ['workflows', 'version', id, version] as const,
  queryFn: async ({ signal }: { signal?: AbortSignal }) =>
    WorkflowVersionSchema.parse(
      await apiFetch(`workflows/${encodeURIComponent(id!)}/versions/${version}`, {
        ...(signal ? { signal } : {}),
      }),
    ),
  retry: false,
  staleTime: Infinity,
})

export function useWorkflowVersion(id: string | undefined, version: number | undefined) {
  return useQuery({
    ...versionQuery(id, version),
    enabled: id !== undefined && version !== undefined,
  })
}

/** One saved version, read on demand (loading an older version into the editor). */
export function fetchWorkflowVersion(queryClient: QueryClient, id: string, version: number) {
  return queryClient.fetchQuery(versionQuery(id, version))
}

/** The graph rules, from the one server function the editor, save and start share. Debounced by the caller's draft. */
export function useValidation(definition: WorkflowDefinition | null) {
  const [debounced, setDebounced] = useState(definition)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(definition), 250)
    return () => clearTimeout(timer)
  }, [definition])
  const query = useQuery({
    queryKey: ['workflows', 'validate', debounced],
    enabled: debounced !== null,
    queryFn: async ({ signal }) =>
      ValidationResultSchema.parse(
        await apiFetch('workflows/validate', {
          method: 'POST',
          body: JSON.stringify({ definition: debounced }),
          signal,
        }),
      ),
    retry: false,
    staleTime: Infinity,
    placeholderData: (previous) => previous,
  })
  return { ...query, pending: definition !== debounced || query.isFetching }
}

export function useSaveWorkflow() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: {
      workflowId: string | null
      baseVersion?: number
      definition: WorkflowDefinition
    }) => {
      const body =
        input.workflowId === null
          ? { definition: input.definition }
          : { baseVersion: input.baseVersion, definition: input.definition }
      const path =
        input.workflowId === null
          ? 'workflows'
          : `workflows/${encodeURIComponent(input.workflowId)}/versions`
      return WorkflowVersionSchema.parse(await post(path, body))
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['workflows'] })
    },
  })
}

export function useDeleteWorkflow() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => {
      await apiFetch(`workflows/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: { 'Idempotency-Key': newId() },
      })
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['workflows'] })
    },
  })
}

export function useExportWorkflow() {
  return useMutation({
    mutationFn: async (input: { id: string; version: number; removePaths: string[] }) =>
      WorkflowExportSchema.parse(
        await apiFetch(
          `workflows/${encodeURIComponent(input.id)}/versions/${input.version}/export`,
          { method: 'POST', body: JSON.stringify({ removePaths: input.removePaths }) },
        ),
      ),
  })
}

// ------------------------------------------------------------------------------------------------------- runs

/** Every workflow run, newest first; `workflow.run.upserted` replaces a run's summary. */
export const workflowRunsQuery = defineStreamQuery<WorkflowRunSummary[]>({
  key: ['workflow-runs', 'list'],
  async fetch() {
    const list = WorkflowRunListSchema.parse(await apiFetch('workflow-runs'))
    return { asOfSeq: list.asOfSeq, data: list.items }
  },
  types: ['workflow.run.upserted'],
  reduce(items, event) {
    if (event.type !== 'workflow.run.upserted') return items
    const next = event.data
    return [...items.filter((item) => item.id !== next.id), next].sort(
      (a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
    )
  },
})

export type WorkflowRunData = {
  snapshot: { asOfSeq: number; run: WorkflowRunDetail }
  events: WorkflowEvent[]
}
export const workflowRunKey = (id: string) => ['workflow-runs', 'run', id] as const

export function useWorkflowRun(id: string | undefined) {
  return useLiveRun<WorkflowRunData>({
    id,
    type: 'workflow.run.upserted',
    key: workflowRunKey(id ?? ''),
    load: async (runId, signal) => {
      const path = `workflow-runs/${encodeURIComponent(runId)}`
      const [snapshot, events] = await Promise.all([
        apiFetch(path, { signal }).then((value) => WorkflowRunSnapshotSchema.parse(value)),
        apiFetch(`${path}/events`, { signal }).then((value) =>
          WorkflowRunEventsSchema.parse(value),
        ),
      ])
      return { snapshot, events: events.events }
    },
  })
}

export function useWorkflowPreflight(workflowId: string | undefined, version: number | undefined) {
  return useQuery({
    queryKey: ['workflow-runs', 'preflight', workflowId, version],
    enabled: workflowId !== undefined && version !== undefined,
    queryFn: async ({ signal }) =>
      WorkflowPreflightSchema.parse(
        await apiFetch(
          `workflow-runs/preflight?${new URLSearchParams({ workflowId: workflowId!, version: String(version) })}`,
          { signal },
        ),
      ),
    retry: false,
    staleTime: 0,
  })
}

export function useCreateWorkflowRun() {
  return useMutation({
    mutationFn: async (body: WorkflowRunCreate) =>
      WorkflowRunCreatedSchema.parse(await post('workflow-runs', body)),
  })
}

/** What the shared decision cards need, plus the workflow-only decisions. */
export function useWorkflowRunActions(id: string) {
  const queryClient = useQueryClient()
  const useAction = <V>(build: (variables: V) => { path: string; body: unknown }) =>
    useMutation({
      mutationFn: async (variables: V) => {
        const { path, body } = build(variables)
        return WorkflowRunSummarySchema.parse(
          await post(`workflow-runs/${encodeURIComponent(id)}/${path}`, body),
        )
      },
      // Also after a failure: a conflict means the run moved on.
      onSettled: () => {
        void queryClient.invalidateQueries({ queryKey: workflowRunKey(id), exact: true })
      },
    })
  const plain =
    <B>(path: string) =>
    (body: B) => ({ path, body })
  return {
    gate: useAction<{ gateId: string; body: GateDecision }>((v) => ({
      path: `gates/${encodeURIComponent(v.gateId)}/decision`,
      body: v.body,
    })),
    limits: useAction<LimitsDecision>(plain('limits')),
    pause: useAction<RunControl>(plain('pause')),
    resume: useAction<RunControl>(plain('resume')),
    stop: useAction<RunControl>(plain('stop')),
    waiver: useAction<WaiverDecision>(plain('waiver')),
    abandon: useAction<AbandonDecision>(plain('abandon')),
    remap: useAction<WorkflowRemapDecision>(plain('remap')),
    retry: useAction<{ nodeId: string; body: WorkflowRetryDecision }>((v) => ({
      path: `nodes/${encodeURIComponent(v.nodeId)}/retry`,
      body: v.body,
    })),
    tryAgain: useAction<{ nodeId: string; body: WorkflowTryAgainDecision }>((v) => ({
      path: `nodes/${encodeURIComponent(v.nodeId)}/try-again`,
      body: v.body,
    })),
  }
}
export type WorkflowRunActions = ReturnType<typeof useWorkflowRunActions>

/** A 409 on save names the version that is now the latest. */
export function latestVersionOf(details: unknown): number | null {
  if (typeof details === 'object' && details !== null && 'latestVersion' in details) {
    const value = (details as { latestVersion: unknown }).latestVersion
    return typeof value === 'number' ? value : null
  }
  return null
}
