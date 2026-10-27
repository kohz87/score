import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { AgentSummary } from '@score/contract'
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { apiFetch } from '../data/api.ts'
import { newId } from '../data/ids.ts'
import { ProfileOperation, useProfileOperation } from '../routes/team/ProfileOperation.tsx'
import { typedMatches, useAgentDelete } from '../routes/team/use-agent-delete.ts'
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
  // 3.7.1: work that is still going (a run that never finished, a queued turn) can be stopped from here, then the panel
  // checks again a few times while the runs report that they stopped.
  const [rechecks, setRechecks] = useState(0)
  const stopWork = useMutation({
    mutationFn: () =>
      apiFetch(`agents/${encodeURIComponent(agentId)}/stop-work`, {
        method: 'POST',
        headers: { 'Idempotency-Key': newId() },
        body: '{}',
      }),
    onSuccess: () => {
      review.mutate()
      setRechecks(6)
    },
  })
  const busy = preview ? preview.pendingWork.activeRuns + preview.pendingWork.queuedTurns : 0
  useEffect(() => {
    if (rechecks <= 0 || busy === 0) return
    const timer = window.setTimeout(() => {
      review.mutate()
      setRechecks((left) => left - 1)
    }, 1500)
    return () => window.clearTimeout(timer)
    // The preview read is the mutation's own; rechecking re-runs it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rechecks, busy])
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
  const needsAttention =
    !coding &&
    !del.operation &&
    lifecycle?.state === 'needs_attention' &&
    Boolean(lifecycle.operationId)
  const held = useProfileOperation(needsAttention ? (lifecycle?.operationId ?? null) : null)
  const heldDone = held.data?.state === 'completed'
  const stuck = needsAttention && !heldDone && held.data ? held.data : null
  useOperationDone(heldDone, heldDone && held.data?.kind === 'delete')
  useEffect(() => {
    if (heldDone && held.data?.kind !== 'delete') review.mutate()
    // Once per completion of the held operation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heldDone])
  // The server's "an operation holds this agent" blocker is replaced by the step's own card, only while that card
  // shows; every other blocker stays. If the operation can't be read, all blockers stay and Remove stays off.
  const blockers = (preview?.blockers ?? []).filter(
    (text) => !(stuck && /operation already holds/i.test(text)),
  )
  // The server decides (3.3.0, decision 134): a setup that stopped with a recorded error may be removed (it is abandoned
  // first), so its preview carries no blocker; one Score lost track of still says an operation holds the agent.
  const blocked = Boolean(preview?.blockers.length)
  const problem = coding
    ? removeCoding.error
    : (del.remove.error ?? (review.error && !preview ? review.error : null))
  const canRemove = coding
    ? !removeCoding.isPending
    : Boolean(preview) && !blocked && typedMatches(del.typedName, agentId) && !del.remove.isPending
  const mistyped = del.typedName.trim() !== '' && !typedMatches(del.typedName, agentId)

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
                {busy > 0 && !del.operation && (
                  <div className="row wrap">
                    <button
                      type="button"
                      className="btn sm"
                      disabled={stopWork.isPending || rechecks > 0}
                      onClick={() => stopWork.mutate()}
                    >
                      {stopWork.isPending || rechecks > 0
                        ? 'Stopping its work…'
                        : stopWork.isSuccess
                          ? `Stop ${name}’s work anyway`
                          : `Stop ${name}’s work`}
                    </button>
                    <span className="small muted">
                      {stopWork.isSuccess
                        ? 'Hermes hasn’t ended its work yet. Pressing again ends it in Score.'
                        : 'Ends its queued messages and asks its running work to stop.'}
                    </span>
                  </div>
                )}
                {stopWork.isError && (
                  <p role="alert">Couldn’t stop its work. Try again, or stop it from its job.</p>
                )}
                <p>
                  A private copy is kept first: <code>{preview.exportPath}</code>. It leaves out
                  credentials and isn’t a full undo.
                </p>
                {blockers.map((blocker) => (
                  <p role="alert" key={blocker}>
                    {blocker}
                  </p>
                ))}
                {stuck && (
                  <p>
                    {blocked
                      ? 'Finish or retry the stopped step first:'
                      : 'Retry the stopped step, or remove the agent below (the stopped setup is abandoned first):'}
                  </p>
                )}
                {!del.operation && !(stuck && blocked) && (
                  <label className="bold-remove-agent-type">
                    Type {agentId} to confirm
                    <input
                      value={del.typedName}
                      autoComplete="off"
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      aria-describedby={mistyped ? 'bold-remove-agent-mistyped' : undefined}
                      onChange={(event) => del.setTypedName(event.target.value)}
                    />
                    {mistyped && (
                      <span id="bold-remove-agent-mistyped" className="small muted">
                        That doesn’t match {agentId}.
                      </span>
                    )}
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
