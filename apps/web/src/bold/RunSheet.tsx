import { useEffect, useRef } from 'react'
import { useStreamQuery, useStreamQueryRefetch } from '../data/query-client.ts'
import { orchestrationsQuery } from '../routes/orchestrations/orchestration-queries.ts'
import { statusLabel } from '../routes/orchestrations/orch-model.ts'
import { workflowRunsQuery } from '../routes/workflows/workflow-queries.ts'
import { RunGraph } from './chats/TopicGraph.tsx'
import type { JobRecipe } from './room/thread-model.ts'

/**
 * 3.29.0: a run that belongs to no chat (from before 3.23) opens here, read-only, over Recipes: the same graph, session
 * log and run details as a chat's Graph tab. A run that has a chat opens in that chat (`/b?run=`, BoldRoom), never here.
 */
export function RunSheet({ briefId, onClose }: { briefId: string; onClose: () => void }) {
  const orchestrations = useStreamQuery(orchestrationsQuery)
  const workflows = useStreamQuery(workflowRunsQuery)
  const refetchOrchestrations = useStreamQueryRefetch(orchestrationsQuery)
  const refetchWorkflows = useStreamQueryRefetch(workflowRunsQuery)
  const workflow = workflows.data?.find((run) => run.briefId === briefId)
  const orchestration = orchestrations.data?.find((run) => run.briefId === briefId)
  const recipe: JobRecipe | null = workflow
    ? { kind: 'workflow', ref: workflow.id }
    : orchestration
      ? { kind: 'orchestration', ref: orchestration.id }
      : null
  const title = workflow?.title ?? orchestration?.title ?? 'Run'
  const status = workflow
    ? statusLabel[workflow.status]
    : orchestration
      ? statusLabel[orchestration.status]
      : null
  const pending = orchestrations.status === 'pending' || workflows.status === 'pending'
  const failed = orchestrations.status === 'error' && workflows.status === 'error'
  const close = useRef<HTMLButtonElement>(null)
  useEffect(() => close.current?.focus(), [])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="bold-rp-scrim">
      <section
        className="bold-rp-runsheet"
        role="dialog"
        aria-modal="true"
        aria-label={`Run: ${title}`}
      >
        <header className="bold-rp-runsheet-head">
          <div>
            <h2>{title}</h2>
            <p className="small muted">
              {status ? `${status} · ` : ''}Read-only: this run belongs to no chat.
            </p>
          </div>
          <button
            ref={close}
            type="button"
            className="bold-rp-sheet-close"
            aria-label="Close the run"
            onClick={onClose}
          >
            ×
          </button>
        </header>
        {recipe ? (
          <RunGraph recipe={recipe} />
        ) : failed ? (
          <p role="alert" className="bold-error">
            Couldn’t load this run.{' '}
            <button
              type="button"
              className="bold-link"
              onClick={() => {
                void refetchOrchestrations()
                void refetchWorkflows()
              }}
            >
              Try again
            </button>
          </p>
        ) : pending ? (
          <p role="status" className="muted">
            Loading the run…
          </p>
        ) : (
          <p role="alert" className="muted">
            That run isn’t available.
          </p>
        )}
      </section>
    </div>
  )
}
