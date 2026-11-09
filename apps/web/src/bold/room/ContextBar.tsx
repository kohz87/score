import { AgentContextSchema, type AgentSummary, type Job } from '@score/contract'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '../../data/api.ts'
import { agentDisplayName } from '../bold-agents.ts'
import { ContextMeter } from '../../routes/chat/ContextMeter.tsx'
import { fetchSessionContext, roomSessionId } from '../../routes/chat/room-actions.ts'
import { SubagentControl } from '../subagents/SubagentControl.tsx'

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
  subagentJob,
  showTopic = true,
  finishedReplies = 0,
  compactSignal,
  compactSubject = null,
}: {
  roomId: string
  to: string[]
  subjectId: string | null
  agents: AgentSummary[]
  ownerId: string | null
  topic: Job | undefined
  /** The room's own job (or the current one) for its subagent control when the message goes to no other job. */
  subagentJob?: Job
  /** Only a chat that holds several active jobs names which one the message goes to; with one job it is just the chat's. */
  showTopic?: boolean
  finishedReplies?: number
  /** `/compress` (from the composer): the meter opens its compaction confirmation for `compactSubject`. */
  compactSignal?: number
  compactSubject?: string | null
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
  const model = session?.model ?? agentModel ?? null
  const where = showTopic && topic && !topic.isDefault ? topic.title : null
  // The control belongs to the job the message goes to; a message to the general conversation uses the room's own job.
  const controlJob = topic && !topic.isDefault ? topic : subagentJob
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
      {subject && sessionId && (
        // The meter is the one the old thread and one-to-one used (its popover holds the breakdown and Compact);
        // the bar variant draws it as the mock-up's track.
        <ContextMeter
          variant="bar"
          roomId={roomId}
          agentId={subject.id}
          name={agentDisplayName(subject)}
          sessionId={sessionId}
          finishedReplies={finishedReplies}
          confirmSignal={
            compactSubject === null || compactSubject === subject.id ? compactSignal : undefined
          }
        />
      )}
      {model && (
        <span className="bold-context-model">
          Model <code>{model}</code>
        </span>
      )}
      {controlJob?.subagents && (
        <SubagentControl
          job={controlJob}
          agentId={controlJob.activeAgents[0] ?? controlJob.holderAgentId ?? subjectId ?? ''}
        />
      )}
      <span className="bold-context-spacer" />
      <span className="bold-context-hint">
        <code>/compress</code> when it fills up
      </span>
    </div>
  )
}
