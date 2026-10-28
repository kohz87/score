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

const onCallStatus = { running: 'Asking', done: 'Answered', failed: 'Failed' } as const

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
      {advisor.mode && (
        <p className="orch-muted">
          {advisor.mode === 'on_call'
            ? 'On call to the workers as well as the lead’s checkpoints.'
            : 'The lead’s checkpoints only.'}
        </p>
      )}
      <p className="orch-advisor-who">
        {agent && <AgentGlyph agent={agent} size="xs" describeShape />}
        <span>{agent?.name ?? advisor.agentId}</span>
      </p>
      {advisor.consults.length === 0 && (advisor.onCall ?? []).length === 0 ? (
        <p className="orch-muted">It has not been asked yet.</p>
      ) : advisor.consults.length === 0 ? null : (
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
      {(advisor.onCall ?? []).length > 0 && (
        <>
          <h4>Asked by the workers</h4>
          <ul className="orch-advisor-list" aria-label="Asked by the workers">
            {(advisor.onCall ?? []).map((entry, index) => (
              <li key={`${entry.stepId}-${index}`}>
                <div className="orch-check-line">
                  <strong>
                    {agents.find((agent) => agent.id === entry.agentId)?.name || entry.agentId} ·
                    step {entry.stepId}
                  </strong>
                  <span>{onCallStatus[entry.status]}</span>
                  <span className="orch-muted">{when(entry.at)}</span>
                  {entry.totalTokens !== null && (
                    <span className="orch-muted">{entry.totalTokens} tokens</span>
                  )}
                </div>
                {entry.question && <p>{entry.question}</p>}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}
