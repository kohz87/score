import { AgentSummarySchema } from '@score/contract'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router'
import { apiFetch } from '../../data/api.ts'
import { newId } from '../../data/ids.ts'
import { useStreamQuery } from '../../data/query-client.ts'
import { roomsQuery } from '../chat/queries.ts'
import { PopOutButton } from '../pop/PopOutButton.tsx'

/**
 * The right of the agent band (design: team.png): Message and Pause as the two main actions, Watch and the pop-out
 * window as quieter ones. The same for Hermes agents and coding agents.
 */
export function AgentHeaderActions({
  agentId,
  agentName,
  paused,
  served,
}: {
  agentId: string
  agentName: string
  paused: boolean
  served: boolean
}) {
  const client = useQueryClient()
  const rooms = useStreamQuery(roomsQuery)
  // The direct room is the agent's home; until it exists, Chat is where to open one.
  const direct = rooms.data?.directs.find((room) => room.leadAgentId === agentId)
  const toggle = useMutation({
    mutationFn: async () =>
      AgentSummarySchema.parse(
        await apiFetch(`agents/${encodeURIComponent(agentId)}/${paused ? 'resume' : 'pause'}`, {
          method: 'POST',
          headers: { 'Idempotency-Key': newId() },
          body: '{}',
        }),
      ),
    onSettled: () => client.invalidateQueries({ queryKey: ['team'] }),
  })
  return (
    <div className="team-band-actions">
      <div className="team-band-main">
        <Link
          className="team-band-primary"
          to={direct ? `/chat/${encodeURIComponent(direct.id)}` : '/chat'}
        >
          Message {agentName}
        </Link>
        <button
          type="button"
          className="team-band-secondary"
          disabled={toggle.isPending}
          onClick={() => toggle.mutate()}
        >
          {paused ? 'Resume' : 'Pause'}
        </button>
      </div>
      {served && (
        <div className="team-band-quiet">
          <Link className="team-band-link" to={`/now/watch/${encodeURIComponent(agentId)}`}>
            Watch {agentName} work
          </Link>
          <PopOutButton agentId={agentId} agentName={agentName} className="team-popout-link" />
        </div>
      )}
      {toggle.error && (
        <p role="alert" className="team-band-error">
          {toggle.error.message}
        </p>
      )}
    </div>
  )
}
