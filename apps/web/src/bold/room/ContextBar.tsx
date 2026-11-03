import { AgentContextSchema, type AgentSummary, type Job } from '@score/contract'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '../../data/api.ts'
import { agentDisplayName } from '../bold-agents.ts'
import { compact } from '../../routes/chat/context-meter.ts'

/**
 * Under the composer (mock-up board 18): who the message goes to and in which topic, the context meter of that agent,
 * its model and the /compress hint. Everything comes from reads that exist (`agents/:id/context`); a missing figure is
 * left out rather than invented.
 */
export function ContextBar({
  to,
  subjectId,
  agents,
  ownerId,
  topic,
}: {
  to: string[]
  subjectId: string | null
  agents: AgentSummary[]
  ownerId: string | null
  topic: Job | undefined
}) {
  const subject = agents.find((agent) => agent.id === subjectId)
  const context = useQuery({
    queryKey: ['chat', 'context', 'bar', subjectId],
    enabled: Boolean(subjectId),
    staleTime: 30_000,
    queryFn: async ({ signal }) =>
      AgentContextSchema.parse(
        await apiFetch(`agents/${encodeURIComponent(subjectId!)}/context`, { signal }),
      ),
  }).data
  const names = to
    .map((id) => agents.find((agent) => agent.id === id))
    .filter((agent): agent is AgentSummary => Boolean(agent))
  const used = context?.tokens ? context.tokens.input + context.tokens.output : null
  const fraction =
    used !== null && context?.contextLength ? Math.min(1, used / context.contextLength) : null
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
            aria-valuetext={`${Math.round(fraction * 100)}% of ${compact(context!.contextLength!)} tokens`}
          >
            <span style={{ width: `${Math.round(fraction * 100)}%` }} />
          </span>
          <span>{Math.round(fraction * 100)}%</span>
        </span>
      )}
      {context?.model && (
        <span>
          Model <code>{context.model}</code>
        </span>
      )}
      <span className="bold-context-spacer" />
      <span>
        <code>/compress</code> when it fills up
      </span>
    </div>
  )
}
