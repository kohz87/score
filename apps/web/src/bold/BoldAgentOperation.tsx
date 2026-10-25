import type { AgentSummary } from '@score/contract'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { useNavigate } from 'react-router'
import {
  ProfileOperation,
  stepLabels,
  useProfileOperation,
} from '../routes/team/ProfileOperation.tsx'

type Lifecycle = NonNullable<AgentSummary['lifecycle']>

/** Tell the team lists an operation finished, and (a removal) leave the page of an agent that is gone. */
export function useOperationDone(done: boolean, removed: boolean) {
  const client = useQueryClient()
  const navigate = useNavigate()
  useEffect(() => {
    if (!done) return
    void client.invalidateQueries({ queryKey: ['team'] })
    void client.invalidateQueries({ queryKey: ['chat', 'agents'] })
    if (removed) void navigate('/b/team')
  }, [done, removed, client, navigate])
}

/**
 * 2.0.6: what an agent that is still being set up, stopped partway or being removed tells the person, on the agent
 * page itself, with the operation's Retry / Confirm right there. It follows the operation live and goes away when the
 * agent is ready. The operation card is the classic one, restyled by bold-team.css.
 */
export function BoldAgentStatus({ name, lifecycle }: { name: string; lifecycle: Lifecycle }) {
  const status = useProfileOperation(lifecycle.operationId)
  const operation = status.data
  const removing = lifecycle.state === 'deleting' || operation?.kind === 'delete'
  const done = operation?.state === 'completed'
  useOperationDone(done === true, done === true && operation?.kind === 'delete')
  if (done) return null
  const stopped = lifecycle.state === 'needs_attention' || operation?.state === 'needs_attention'
  const step = stepLabels[operation?.nextStep ?? ''] ?? null
  const line = stopped
    ? `${removing ? 'Removing' : 'Setting up'} ${name} stopped${step ? ` at ${step}` : ''}${
        operation?.error ? `: ${operation.error}` : '.'
      }`
    : `${removing ? 'Removing' : 'Setting up'} ${name}…`
  return (
    <section
      className="bold-agent-status"
      data-protected="block"
      aria-label={`${name} status`}
      data-state={stopped ? 'stopped' : 'working'}
    >
      <p className="bold-agent-status-line" role="status">
        {line}
      </p>
      {operation && <ProfileOperation operation={operation} />}
      {status.isError && (
        <p role="alert">
          Couldn’t load the status.{' '}
          <button type="button" className="link" onClick={() => void status.refetch()}>
            Try again
          </button>
        </p>
      )}
    </section>
  )
}
