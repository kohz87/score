import {
  AgentDetailSchema,
  AgentOperationSchema,
  AgentPreviewSchema,
  type AgentDetail,
  type AgentOperation,
  type AgentPreview,
} from '@score/contract'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { apiFetch } from '../../data/api.ts'
import { ProfileOperation, useProfileOperation } from './ProfileOperation.tsx'
import { newId } from '../../data/ids.ts'

export function ProfileSettings({ agent }: { agent: AgentDetail }) {
  const client = useQueryClient()
  const [name, setName] = useState(agent.name)
  const [role, setRole] = useState(agent.role)
  const [typedName, setTypedName] = useState('')
  const [preview, setPreview] = useState<AgentPreview | null>(null)
  const [accepted, setAccepted] = useState<AgentOperation | null>(null)
  const status = useProfileOperation(accepted?.id ?? agent.lifecycle?.operationId ?? null)
  const operation = status.data ?? accepted
  const save = useMutation({
    mutationFn: async () =>
      AgentDetailSchema.parse(
        await apiFetch(`agents/${encodeURIComponent(agent.id)}`, {
          method: 'PATCH',
          headers: { 'Idempotency-Key': newId() },
          body: JSON.stringify({ name, role }),
        }),
      ),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['team', 'detail', agent.id] })
    },
  })
  const review = useMutation({
    mutationFn: async () =>
      AgentPreviewSchema.parse(
        await apiFetch('agents/preview', {
          method: 'POST',
          body: JSON.stringify({ kind: 'delete', agentId: agent.id }),
        }),
      ),
    onSuccess: (value) => {
      setPreview(value)
      setTypedName('')
    },
  })
  const remove = useMutation({
    mutationFn: async () =>
      AgentOperationSchema.parse(
        await apiFetch(`agents/${encodeURIComponent(agent.id)}`, {
          method: 'DELETE',
          headers: { 'Idempotency-Key': newId() },
          body: JSON.stringify({ typedName, previewHash: preview!.hash }),
        }),
      ),
    onSuccess: setAccepted,
    onError: () => {
      setPreview(null)
      setTypedName('')
    },
  })
  if (agent.lifecycle && agent.lifecycle.state !== 'ready')
    return (
      <div className="team-stack">
        {operation && <ProfileOperation operation={operation} />}
        {status.isError && (
          <p role="alert">
            Couldn’t load operation status.{' '}
            <button onClick={() => void status.refetch()}>Try again</button>
          </p>
        )}
        {agent.lifecycle.state === 'removed' && (
          <p>This agent has been removed. Its history is kept.</p>
        )}
      </div>
    )
  return (
    <div className="team-stack team-section-gap">
      <section className="team-card">
        <h2>Agent details</h2>
        <form
          className="team-routine-form"
          onSubmit={(event) => {
            event.preventDefault()
            save.mutate()
          }}
        >
          <label>
            Display name
            <input
              required
              maxLength={100}
              value={name}
              onChange={(event) => {
                setName(event.target.value)
                save.reset()
              }}
            />
          </label>
          <p className="team-muted-strong">
            Profile name: <code>{agent.id}</code>
          </p>
          <label>
            Edit description
            <textarea
              required
              maxLength={2000}
              value={role}
              onChange={(event) => {
                setRole(event.target.value)
                save.reset()
              }}
            />
          </label>
          <div className="team-file-actions">
            <button className="team-primary" disabled={save.isPending}>
              Save details
            </button>
          </div>
          {save.error && <p role="alert">{save.error.message}</p>}
          {save.isSuccess && <p role="status">Details saved.</p>}
        </form>
      </section>
      <section className="team-card team-profile-danger">
        <h2>Danger zone</h2>
        <p>A private export is kept first. It omits credentials and is not a full undo.</p>
        {!preview ? (
          <div className="team-file-actions">
            <button
              disabled={agent.id === 'default' || review.isPending}
              onClick={() => review.mutate()}
            >
              Delete agent
            </button>
          </div>
        ) : (
          <>
            <h3>Review deletion</h3>
            <p>
              {preview.pendingWork.activeRuns} active runs · {preview.pendingWork.queuedTurns}{' '}
              queued messages · {preview.pendingWork.pendingApprovals} pending approvals ·{' '}
              {preview.pendingWork.assignments} unfinished assignments
            </p>
            <p>{preview.pendingWork.disposition}</p>
            <p>
              Private export: <code>{preview.exportPath}</code>
            </p>
            {preview.blockers.map((blocker) => (
              <p role="alert" key={blocker}>
                {blocker}
              </p>
            ))}
            <form
              className="team-routine-form"
              onSubmit={(event) => {
                event.preventDefault()
                remove.mutate()
              }}
            >
              <label>
                Type {agent.id} to confirm
                <input
                  value={typedName}
                  autoComplete="off"
                  onChange={(event) => setTypedName(event.target.value)}
                />
              </label>
              <div className="team-file-actions">
                <button
                  className="team-primary"
                  disabled={
                    typedName !== agent.id || Boolean(preview.blockers.length) || remove.isPending
                  }
                >
                  Confirm deletion
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setPreview(null)
                    setTypedName('')
                  }}
                >
                  Cancel
                </button>
              </div>
            </form>
          </>
        )}
        {(review.error || remove.error) && (
          <p role="alert">{(review.error ?? remove.error)?.message}</p>
        )}
        {operation && <ProfileOperation operation={operation} />}
      </section>
    </div>
  )
}
