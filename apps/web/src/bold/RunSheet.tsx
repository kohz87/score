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
  const dialog = useRef<HTMLDialogElement>(null)
  // The parent passes a fresh function each render; the dialog must not close and reopen for that.
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  })
  // A native modal dialog: focus is trapped and the page behind is inert; Escape closes it, and closing gives the focus
  // back to what had it before (the library's card link, or nothing on a direct URL).
  useEffect(() => {
    const node = dialog.current
    if (!node) return
    const closed = () => onCloseRef.current()
    node.addEventListener('close', closed)
    // jsdom has no showModal; the open attribute is enough there.
    if (!node.open) {
      if (typeof node.showModal === 'function') node.showModal()
      else node.setAttribute('open', '')
    }
    return () => {
      node.removeEventListener('close', closed)
      if (node.open && typeof node.close === 'function') node.close()
    }
  }, [])
  return (
    <dialog ref={dialog} className="bold-rp-runsheet" aria-label={`Run: ${title}`}>
      <header className="bold-rp-runsheet-head">
        <div>
          <h2>{title}</h2>
          <p className="small muted">{status ? `${status} · ` : ''}This run belongs to no chat.</p>
        </div>
        <button
          type="button"
          className="bold-rp-sheet-close"
          aria-label="Close the run"
          autoFocus
          onClick={() =>
            typeof dialog.current?.close === 'function' ? dialog.current.close() : onClose()
          }
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
    </dialog>
  )
}
