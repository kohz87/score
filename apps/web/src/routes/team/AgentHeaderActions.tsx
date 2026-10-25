import { AgentSummarySchema } from '@score/contract'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from '../../shell/framed-paths.tsx'
import { apiFetch } from '../../data/api.ts'
import { newId } from '../../data/ids.ts'
import { useStreamQuery } from '../../data/query-client.ts'
import { roomsQuery } from '../chat/queries.ts'

/**
 * The right of the agent band (design: team.png): Message and Pause as the two main actions, with Watch as the quieter
 * one. The same for Hermes agents and coding agents.
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
  // The direct room is the agent's home. Chat is the fallback only once the rooms have loaded (or failed to) and
  // there is no direct room; before that the button waits instead of sending the person to the wrong place.
  const roomsLoading = rooms.status === 'pending'
  const direct = rooms.data?.directs.find((room) => room.leadAgentId === agentId)
  const toggle = useMutation({
    mutationFn: async (action: 'pause' | 'resume') =>
      AgentSummarySchema.parse(
        await apiFetch(`agents/${encodeURIComponent(agentId)}/${action}`, {
          method: 'POST',
          headers: { 'Idempotency-Key': newId() },
          body: '{}',
        }),
      ),
    onSettled: () => client.invalidateQueries({ queryKey: ['team'] }),
  })
  const failed = toggle.isError ? toggle.variables : null
  return (
    <div className="team-band-actions">
      <div className="team-band-main">
        {roomsLoading ? (
          <span
            className="team-band-primary"
            role="link"
            aria-disabled="true"
            aria-label={`Message ${agentName}, loading`}
          >
            Message {agentName}
          </span>
        ) : (
          <Link
            className="team-band-primary"
            to={direct ? `/chat/${encodeURIComponent(direct.id)}` : '/chat'}
          >
            Message {agentName}
          </Link>
        )}
        {/* The server can commit a pause and still answer with an error (some tasks couldn't be held). While that
            error shows, the button repeats the action that failed, whatever the status says now. */}
        <button
          type="button"
          className="team-band-secondary"
          disabled={toggle.isPending}
          onClick={() => toggle.mutate(failed ?? (paused ? 'resume' : 'pause'))}
        >
          {failed
            ? `${failed === 'pause' ? 'Pause' : 'Resume'} again`
            : paused
              ? 'Resume'
              : 'Pause'}
        </button>
      </div>
      {served && (
        <div className="team-band-quiet">
          <Link className="team-band-link" to={`/watch/${encodeURIComponent(agentId)}`}>
            Watch {agentName} work
          </Link>
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
