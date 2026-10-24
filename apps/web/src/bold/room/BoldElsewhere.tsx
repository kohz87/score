import type { AgentSummary, OutsideSession } from '@score/contract'
import { useMemo } from 'react'
import { useStreamQuery } from '../../data/query-client.ts'
import { useBringOutsideSessionIntoJob } from '../../data/outside-job.ts'
import { teamRoomQuery } from './room-queries.ts'

function when(iso: string): string {
  return new Date(iso).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

/** One of the agents' own chats (PLAN 11.4d): read-only in Hermes, until the person brings it into a team job. */
export function BoldElsewhere({
  session,
  agents,
  onBroughtIn,
}: {
  session: OutsideSession
  agents: AgentSummary[]
  onBroughtIn: (jobId: string) => void
}) {
  const teamDefinition = useMemo(() => teamRoomQuery(null), [])
  const team = useStreamQuery(teamDefinition).data
  const bring = useBringOutsideSessionIntoJob()
  const agent = agents.find((item) => item.id === session.agentId)
  const title = session.title.trim() || 'Untitled session'
  const source = session.sourceLabel

  return (
    <div className="sidebody bold-elsewhere">
      <span className="note bold-elsewhere-note" data-protected="any">
        From {source} · read-only. Reply there, or bring it into a job.
      </span>
      <div className="bold-elsewhere-title">
        <span className="small muted">
          <b>{agent?.name ?? session.agentId}</b> · {source}
        </span>
        <h2>{title}</h2>
        <span className="small muted">
          {session.messageCount} {session.messageCount === 1 ? 'message' : 'messages'} · started{' '}
          {when(session.startedAt)}
          {session.busy ? ' · active now' : ''}
        </span>
      </div>
      <div className="card bold-elsewhere-card">
        <b>
          This conversation stays with {agent?.name ?? session.agentId} in {source}.
        </b>
        <span>
          Score can copy its text into a team job, but it can’t reply in {source} or change the
          original chat.
        </span>
      </div>
      <div className="row wrap bold-elsewhere-actions">
        <button
          type="button"
          className="btn primary"
          disabled={!team || bring.isPending}
          onClick={() => {
            if (!team) return
            bring.mutate(
              { session, teamRoomId: team.id },
              { onSuccess: ({ job }) => onBroughtIn(job.id) },
            )
          }}
        >
          {bring.isPending ? 'Bringing it in…' : 'Bring into a job'}
        </button>
        <span className="small muted">
          Starts “{title}” in the team room, with this chat attached.
        </span>
      </div>
      {bring.isError && (
        <p className="bold-request-error" role="alert">
          Couldn’t bring this chat into a job. Try again.
        </p>
      )}
    </div>
  )
}
