import type { AgentSummary, WorkflowPreflight } from '@score/contract'
import { CodingWorkers, PreflightList } from '../orchestrations/NewOrchestrationDialog.tsx'

export function StartWorkflowChecks({
  checking,
  checkError,
  checks,
  problems,
  workers,
  agents,
  reachAccepted,
  onAcceptReach,
}: {
  checking: boolean
  checkError: boolean
  checks?: WorkflowPreflight['checks']
  problems: WorkflowPreflight['issues']
  workers: WorkflowPreflight['workers']
  agents: AgentSummary[]
  reachAccepted: boolean
  onAcceptReach: (accepted: boolean) => void
}) {
  return (
    <section aria-label="Before it starts">
      <h3>Before it starts</h3>
      {checking && <p role="status">Checking…</p>}
      {checkError && (
        <p role="alert" className="orch-error">
          Couldn’t run the checks.
        </p>
      )}
      {checks && <PreflightList checks={checks} />}
      {problems.length > 0 && (
        <ul className="orch-checks" aria-label="Problems with the workflow">
          {problems.map((issue, index) => (
            <li key={index} className="orch-check-item orch-check-item--fail">
              <strong>Problem</strong>
              <span>{issue.message}</span>
            </li>
          ))}
        </ul>
      )}
      {workers.length > 0 && (
        <CodingWorkers
          workers={workers}
          agents={agents}
          accepted={reachAccepted}
          onAccept={onAcceptReach}
          answerGoesTo="passed to the steps after it, which may use an online model"
        />
      )}
      <p className="orch-muted">
        Watch also shows the agent’s other work; it can’t show a single run on its own.
      </p>
    </section>
  )
}
