import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { AgentSummary } from '@score/contract'
import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router'
import { apiFetch } from '../data/api.ts'
import { ProfileOperation, useProfileOperation } from '../routes/team/ProfileOperation.tsx'
import { useAgentDelete } from '../routes/team/use-agent-delete.ts'
import { useOperationDone } from './BoldAgentOperation.tsx'
import { removeProblem } from './RemoveConfirm.tsx'

/**
 * "Remove agent…" on the agent page, in place. A Hermes agent shows what is still going and a private-copy note
 * (the delete preview), then asks for its name; a coding agent just asks. It decides something for the person, so it
 * is a protected surface. Escape and Cancel close it; the page returns focus to the button that opened it.
 */
export function BoldRemoveAgent({
  agentId,
  name,
  coding,
  lifecycle,
  onClose,
}: {
  agentId: string
  name: string
  coding: boolean
  lifecycle?: AgentSummary['lifecycle']
  onClose: () => void
}) {
  const navigate = useNavigate()
  const client = useQueryClient()
  const cancelButton = useRef<HTMLButtonElement>(null)
  const del = useAgentDelete(agentId, null, true)
  const { review } = del
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const removeCoding = useMutation({
    mutationFn: () =>
      apiFetch(`coding-agents/${encodeURIComponent(agentId)}`, { method: 'DELETE' }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['team'] })
      void client.invalidateQueries({ queryKey: ['chat', 'agents'] })
      // The list refreshes even when the person has left; only the navigation needs the panel still open.
      if (mounted.current) void navigate('/b/team')
    },
  })

  useEffect(() => cancelButton.current?.focus(), [])
  useEffect(() => {
    if (!coding) review.mutate()
    // Once per open: the preview is the page's snapshot of what removing would touch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const done = del.operation?.state === 'completed'
  useEffect(() => {
    if (!done) return
    void client.invalidateQueries({ queryKey: ['team'] })
    void client.invalidateQueries({ queryKey: ['chat', 'agents'] })
    void navigate('/b/team')
  }, [done, client, navigate])

  const preview = del.preview
  const working = del.operation?.state === 'running'
  // Failed, needs attention or otherwise not completed: the progress stays, and the person can close the panel.
  const ended = Boolean(del.operation) && !working && !done
  const pending = del.remove.isPending || removeCoding.isPending
  const closeButton = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (ended) closeButton.current?.focus()
  }, [ended])
  // 2.0.6: an operation that stopped partway holds the agent. Its Retry / Confirm is shown here, and the preview
  // runs again once it finishes, so Remove is never a dead button with the way out buried elsewhere.
  const heldBlocker = (text: string) => /operation already holds/i.test(text)
  const holds =
    !coding &&
    !del.operation &&
    Boolean(lifecycle?.operationId) &&
    (lifecycle?.state === 'needs_attention' || Boolean(preview?.blockers.some(heldBlocker)))
  const held = useProfileOperation(holds ? (lifecycle?.operationId ?? null) : null)
  const heldDone = held.data?.state === 'completed'
  const stuck = holds && !heldDone && held.data ? held.data : null
  useOperationDone(heldDone, heldDone && held.data?.kind === 'delete')
  useEffect(() => {
    if (heldDone && held.data?.kind !== 'delete') review.mutate()
    // Once per completion of the held operation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heldDone])
  const blockers = (preview?.blockers ?? []).filter((text) => !(stuck && heldBlocker(text)))
  const blocked = Boolean(preview?.blockers.length) || Boolean(stuck)
  const problem = coding
    ? removeCoding.error
    : (del.remove.error ?? (review.error && !preview ? review.error : null))
  const canRemove = coding
    ? !removeCoding.isPending
    : Boolean(preview) && !blocked && del.typedName === agentId && !del.remove.isPending

  return (
    <div
      className="bold-remove-agent"
      data-protected="block"
      role="group"
      aria-label={`Remove ${name}`}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !working && !pending && !done) {
          event.stopPropagation()
          onClose()
        }
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault()
          if (!canRemove) return
          if (coding) removeCoding.mutate()
          else del.remove.mutate()
        }}
      >
        {coding ? (
          <p>Removes {name} from the team. Past work stays in rooms.</p>
        ) : (
          <>
            {review.isPending && <p role="status">Checking what removing {name} would touch…</p>}
            {preview && (
              <>
                <p>
                  Still going: {preview.pendingWork.activeRuns} active runs ·{' '}
                  {preview.pendingWork.queuedTurns} queued messages ·{' '}
                  {preview.pendingWork.pendingApprovals} pending approvals ·{' '}
                  {preview.pendingWork.assignments} unfinished assignments.
                </p>
                <p>{preview.pendingWork.disposition}</p>
                <p>
                  A private copy is kept first: <code>{preview.exportPath}</code>. It leaves out
                  credentials and isn’t a full undo.
                </p>
                {blockers.map((blocker) => (
                  <p role="alert" key={blocker}>
                    {blocker}
                  </p>
                ))}
                {stuck && <p>Finish or retry the stopped step first:</p>}
                {!del.operation && !stuck && (
                  <label className="bold-remove-agent-type">
                    Type {agentId} to confirm
                    <input
                      value={del.typedName}
                      autoComplete="off"
                      onChange={(event) => del.setTypedName(event.target.value)}
                    />
                  </label>
                )}
              </>
            )}
          </>
        )}
        {problem != null && <p role="alert">{removeProblem(problem, name)}</p>}
        {ended && (
          <div className="row wrap">
            <button ref={closeButton} type="button" className="btn sm" onClick={onClose}>
              Close
            </button>
          </div>
        )}
        {!del.operation && (
          <div className="row wrap">
            <button
              ref={cancelButton}
              type="button"
              className="btn sm"
              disabled={pending}
              onClick={onClose}
            >
              Cancel
            </button>
            {!stuck && (
              <button type="submit" className="btn sm primary" disabled={!canRemove}>
                {pending ? 'Removing…' : 'Remove'}
              </button>
            )}
          </div>
        )}
      </form>
      {stuck && <ProfileOperation operation={stuck} />}
      {del.operation && <ProfileOperation operation={del.operation} />}
    </div>
  )
}
