import { type AgentSummary, type CodingWorkerPreflight, type PreflightCheck } from '@score/contract'
import { AgentChip } from './decision-parts.tsx'
import { readinessText } from './orch-model.ts'

const checkWord: Record<PreflightCheck['status'], string> = {
  ok: 'Ready',
  fail: 'Missing',
  unknown: 'Can’t be checked',
}

/**
 * The coding agents of a run and what each can read, in plain words. A reach beyond the workspace needs one
 * acknowledgement for the whole list; `accepted` says whether it covers the policies shown right now.
 */
export function CodingWorkers({
  workers,
  agents,
  accepted,
  onAccept,
  answerGoesTo = 'handed back to the lead, which uses an online model',
}: {
  workers: CodingWorkerPreflight[]
  agents: AgentSummary[]
  accepted: boolean
  onAccept: (accepted: boolean) => void
  /** Where the answer goes after the run keeps it (an orchestration hands it to its lead; a workflow to later steps). */
  answerGoesTo?: string
}) {
  const wide = workers.some((worker) => worker.reachBeyondWorkspace)
  return (
    // The reach of each coding agent, the risk in plain words and the acknowledgement are one protected surface (X1).
    <section aria-label="Coding agents in this run" className="orch-workers" data-protected="block">
      <h3>Coding agents in this run</h3>
      <p className="orch-muted">
        Claude Code and Codex work on this computer, in the workspace you gave them. This is what
        each one can read and do in this run.
      </p>
      <ul>
        {workers.map((worker) => (
          <li key={worker.agentId} data-ready={worker.readiness === 'ready'}>
            <AgentChip agentId={worker.agentId} agents={agents} />
            {worker.readiness === 'ready' && worker.reach ? (
              <p>{worker.reach}</p>
            ) : (
              <p className="orch-error">{worker.detail ?? readinessText[worker.readiness]}</p>
            )}
          </li>
        ))}
      </ul>
      {wide && (
        <div className="orch-risk">
          <p>
            <strong>What to know first.</strong> Whatever a coding agent can read, it can repeat in
            its answer. That answer is shown in the run, kept in Score and {answerGoesTo}. If those
            files hold anything private, such as keys or passwords, pick another agent or don’t
            start this run.
          </p>
          <label className="orch-check orch-ack" data-protected="any">
            <input
              type="checkbox"
              checked={accepted}
              onChange={(event) => onAccept(event.target.checked)}
            />
            <span>
              I understand what these coding agents can read, and I accept it for this run.
            </span>
          </label>
        </div>
      )}
    </section>
  )
}

export function PreflightList({
  checks,
}: {
  checks: (Pick<PreflightCheck, 'status' | 'message'> & { id: string })[]
}) {
  return (
    <ul className="orch-checks" aria-label="Checks before starting">
      {checks.map((check) => (
        <li key={check.id} className={`orch-check-item orch-check-item--${check.status}`}>
          <strong>{checkWord[check.status]}</strong>
          <span>{check.message}</span>
        </li>
      ))}
    </ul>
  )
}
