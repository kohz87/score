import type { AgentSummary, WorkflowPreflight } from '@score/contract'
import { AgentChip } from '../orchestrations/RunDecisions.tsx'

export function StartWorkflowAgents({
  mapping,
  agents,
}: {
  mapping?: WorkflowPreflight['mapping']
  agents: AgentSummary[]
}) {
  return (
    <section aria-label="Agents this run will use">
      <h3>Agents this run will use</h3>
      {mapping ? (
        <ul className="wf-agents" aria-label="Agent mapping">
          {mapping.map((entry) => (
            <li key={entry.agentId}>
              <AgentChip agentId={entry.agentId} agents={agents} />{' '}
              <span className="orch-mono" title="Identifies the exact version of the agent">
                {entry.incarnation}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="orch-muted" role="status">
          Reading the agents…
        </p>
      )}
      <p className="orch-muted">
        The run keeps using exactly these agents. If one is replaced later, its steps wait until you
        decide.
      </p>
    </section>
  )
}
