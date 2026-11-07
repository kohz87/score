import type { AgentSummary, HermesUpdateJob } from '@score/contract'
import { MARK, STEP_LABEL } from './hermes-update-model.ts'

export function Progress({ job, agents }: { job: HermesUpdateJob; agents: AgentSummary[] }) {
  const tester = job.testAgentId
    ? (agents.find((agent) => agent.id === job.testAgentId)?.name ?? job.testAgentId)
    : null
  return (
    <div className="bold-hu-run" data-protected="block">
      {/* Only the steps are announced, not Hermes's output every poll (review). */}
      <ol role="status" aria-label="Update progress">
        {job.steps.map((step) => (
          <li key={step.id} data-state={step.state}>
            <span className="bold-hu-dot" aria-hidden="true">
              {MARK[step.state]}
            </span>
            <span className="bold-hu-label">
              {step.id === 'test'
                ? step.state === 'skipped' || !tester
                  ? 'No test message'
                  : `Test message to ${tester}`
                : STEP_LABEL[step.id]}
              <span className="bold-hu-state"> ({step.state})</span>
            </span>
            <span className="bold-hu-note">{step.note}</span>
          </li>
        ))}
      </ol>
      <details open={job.outcome === 'failed' || undefined}>
        <summary>Hermes’s output</summary>
        <pre className="bold-hu-log">{job.log.length ? job.log.join('\n') : 'No output yet.'}</pre>
      </details>
    </div>
  )
}
