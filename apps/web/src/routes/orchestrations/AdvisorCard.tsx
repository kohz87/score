import type { AdvisorConsultView, AgentSummary, OrchestrationDetail } from '@score/contract'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'

// 3.14: the job's advisor and each time Score asked it. Read-only: the lead decides what to do with the advice.

const checkpointLabel: Record<AdvisorConsultView['checkpoint'], string> = {
  before_plan: 'Before the plan',
  repeat_failure: 'Same failure twice',
  before_done: 'Before it finishes',
}
const statusLabel: Record<AdvisorConsultView['status'], string> = {
  pending_gate: 'Waiting for you',
  queued: 'Waiting to ask',
  admitted: 'Looking',
  succeeded: 'Advice given',
  failed: 'Failed',
  unknown: 'Unknown',
  cancelled: 'Stopped',
  blocked: 'Blocked',
  rejected: 'Not allowed',
  not_started: 'Did not start',
}

const when = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })

export function AdvisorCard({
  run,
  agents,
}: {
  run: Pick<OrchestrationDetail, 'advisor'>
  agents: AgentSummary[]
}) {
  const advisor = run.advisor
  if (!advisor) return null
  const agent = agents.find((item) => item.id === advisor.agentId)
  return (
    <section className="orch-advisor" aria-label="Advisor">
      <h3>Advisor</h3>
      <p className="orch-advisor-who">
        {agent && <AgentGlyph agent={agent} size="xs" describeShape />}
        <span>{agent?.name ?? advisor.agentId}</span>
      </p>
      {advisor.consults.length === 0 ? (
        <p className="orch-muted">It has not been asked yet.</p>
      ) : (
        <ul className="orch-advisor-list">
          {advisor.consults.map((consult) => (
            <li key={consult.stepId}>
              <div className="orch-check-line">
                <strong>{checkpointLabel[consult.checkpoint]}</strong>
                <span>{statusLabel[consult.status]}</span>
                <span className="orch-muted">{when(consult.createdAt)}</span>
              </div>
              {consult.reason !== '' && <p className="orch-muted">{consult.reason}</p>}
              {consult.advice && <p className="orch-advisor-advice">{consult.advice}</p>}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
