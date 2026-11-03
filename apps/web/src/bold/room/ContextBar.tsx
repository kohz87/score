import { AgentContextSchema, type AgentSummary, type Job } from '@score/contract'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '../../data/api.ts'
import { agentDisplayName } from '../bold-agents.ts'
import { compact } from '../../routes/chat/context-meter.ts'
import { fetchSessionContext, roomSessionId } from '../../routes/chat/room-actions.ts'

/** The session the next message goes to: the room's own for the general conversation, else the topic's own. */
export function topicSessionId(
  roomId: string,
  topic: Pick<Job, 'id' | 'isDefault'> | undefined,
  agentId: string,
): string {
  return !topic || topic.isDefault
    ? roomSessionId(roomId, agentId)
    : `score-${roomId}-${topic.id}-${agentId}`
}

/**
 * Under the composer (mock-up board 18): who the message goes to and in which topic, the context meter of that agent,
 * its model and the /compress hint. Everything comes from reads that exist (the session's `…/context`, the agent's model); a missing figure is
 * left out rather than invented.
 */
export function ContextBar({
  roomId,
  to,
  subjectId,
  agents,
  ownerId,
  topic,
}: {
  roomId: string
  to: string[]
  subjectId: string | null
  agents: AgentSummary[]
  ownerId: string | null
  topic: Job | undefined
}) {
  const subject = agents.find((agent) => agent.id === subjectId)
  // The meter reads the session this message lands in (3.22.0 review): the agent's last session may be another chat's.
  const sessionId = subjectId ? topicSessionId(roomId, topic, subjectId) : null
  const session = useQuery({
    queryKey: ['chat', 'context', 'bar', subjectId, sessionId],
    enabled: Boolean(subjectId && sessionId),
    staleTime: 15_000,
    refetchInterval: 30_000,
    queryFn: () => fetchSessionContext(subjectId!, sessionId!),
  }).data
  // The model is the agent's when this session has not run yet.
  const agentModel = useQuery({
    queryKey: ['chat', 'context', 'bar-model', subjectId],
    enabled: Boolean(subjectId),
    staleTime: 60_000,
    queryFn: async ({ signal }) =>
      AgentContextSchema.parse(
        await apiFetch(`agents/${encodeURIComponent(subjectId!)}/context`, { signal }),
      ).model,
  }).data
  const names = to
    .map((id) => agents.find((agent) => agent.id === id))
    .filter((agent): agent is AgentSummary => Boolean(agent))
  const used = session?.used ?? null
  const windowSize = session?.window ?? null
  const fraction = used !== null && windowSize ? Math.min(1, used / windowSize) : null
  const model = session?.model ?? agentModel ?? null
  const where = topic && !topic.isDefault ? topic.title : null
  return (
    <div className="bold-context-bar" aria-label="Where this message goes">
      <span className="bold-context-to">
        To{' '}
        {names.length > 0 ? (
          names.map((agent, index) => (
            <strong key={agent.id}>
              {index > 0 && ', '}
              {agentDisplayName(agent)}
            </strong>
          ))
        ) : subject ? (
          <>
            <strong>{agentDisplayName(subject)}</strong>
            {subject.id === ownerId && ' (owner)'}
          </>
        ) : (
          <strong>nobody yet</strong>
        )}
        {where && (
          <>
            {' '}
            · in <strong>{where}</strong>
          </>
        )}
      </span>
      {fraction !== null && used !== null && (
        <span className="bold-context-meter">
          Context{' '}
          <span
            className="bold-context-track"
            role="meter"
            aria-label="Context used"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(fraction * 100)}
            aria-valuetext={`${Math.round(fraction * 100)}% of ${compact(windowSize!)} tokens`}
          >
            <span style={{ width: `${Math.round(fraction * 100)}%` }} />
          </span>
          <span>{Math.round(fraction * 100)}%</span>
        </span>
      )}
      {model && (
        <span>
          Model <code>{model}</code>
        </span>
      )}
      <span className="bold-context-spacer" />
      <span>
        <code>/compress</code> when it fills up
      </span>
    </div>
  )
}
