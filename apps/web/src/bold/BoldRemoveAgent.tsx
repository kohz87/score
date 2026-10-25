import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router'
import { apiFetch } from '../data/api.ts'
import { ProfileOperation } from '../routes/team/ProfileOperation.tsx'
import { useAgentDelete } from '../routes/team/use-agent-delete.ts'
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
  onClose,
}: {
  agentId: string
  name: string
  coding: boolean
  onClose: () => void
}) {
  const navigate = useNavigate()
  const client = useQueryClient()
  const cancelButton = useRef<HTMLButtonElement>(null)
  const del = useAgentDelete(agentId)
  const { review } = del
  const removeCoding = useMutation({
    mutationFn: () =>
      apiFetch(`coding-agents/${encodeURIComponent(agentId)}`, { method: 'DELETE' }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['team'] })
      void client.invalidateQueries({ queryKey: ['chat', 'agents'] })
      void navigate('/b/team')
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
  const working = Boolean(del.operation)
  const blocked = Boolean(preview?.blockers.length)
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
        if (event.key === 'Escape' && !working) {
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
                {preview.blockers.map((blocker) => (
                  <p role="alert" key={blocker}>
                    {blocker}
                  </p>
                ))}
                {!working && (
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
        {!working && (
          <div className="row wrap">
            <button ref={cancelButton} type="button" className="btn sm" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn sm primary" disabled={!canRemove}>
              {del.remove.isPending || removeCoding.isPending ? 'Removing…' : 'Remove'}
            </button>
          </div>
        )}
      </form>
      {del.operation && <ProfileOperation operation={del.operation} />}
    </div>
  )
}
