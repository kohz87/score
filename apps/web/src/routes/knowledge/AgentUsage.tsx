import { useKnowledgeAgentUsage } from './agent-usage-queries.ts'

/** Today's agent writes (limit: 60 per hour per agent). Renders nothing until there is something to show. */
export function AgentUsage() {
  const usage = useKnowledgeAgentUsage()
  const items = usage.data?.items ?? []
  if (!items.length) return null
  return (
    <div>
      <h3 className="kn-subhead">Agent writes today</h3>
      <ul className="kn-usage">
        {items.map((item) => (
          <li key={item.agentId}>
            <span>{item.agentId}</span>
            <strong>{item.writesToday}</strong>
          </li>
        ))}
      </ul>
    </div>
  )
}
