import type { CheckRunView, OrchestrationDetail } from '@score/contract'
import { describeOrchError } from './orchestration-queries.ts'

// 3.13: the job's oracle. The command, its latest runs and the two things the person may do about it.

type Outcome = CheckRunView['outcome']
const outcomeLabel: Record<Outcome, string> = {
  queued: 'Queued',
  cancelled: 'Stopped',
  running: 'Running',
  passed: 'Passed',
  failed: 'Failed',
  timed_out: 'Timed out',
  interrupted: 'Interrupted',
  refused: 'Could not run',
}
const reasonLabel: Record<CheckRunView['reason'], string> = {
  lead: 'Asked by the lead',
  step: 'After a step',
  person: 'Asked by you',
}

const when = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })

type Act = {
  mutate: (variables: { orchestrationRevision: number }) => void
  isPending: boolean
  error: unknown
}
export type CheckActions = { checkRun: Act; checkWaive: Act }

export function CheckCard({
  run,
  actions,
}: {
  run: Pick<OrchestrationDetail, 'check' | 'status' | 'revision'>
  actions: CheckActions
}) {
  const check = run.check
  if (!check) return null
  const live = run.status === 'running' || run.status === 'paused'
  const control = { orchestrationRevision: run.revision }
  const runs = check.runs.slice(0, 5)
  const waived = check.waivedAt !== null
  const error = actions.checkRun.error ?? actions.checkWaive.error
  const pending = check.runs.some((item) => item.outcome === 'queued' || item.outcome === 'running')
  return (
    <section className="orch-check" aria-label="Check">
      <h3>Check</h3>
      <p className="orch-check-command">
        <code>{check.command}</code>
      </p>
      <p className="orch-muted">
        In <code className="orch-mono">{check.workspace}</code>,{' '}
        {check.when === 'each_step' ? 'after every step and before finishing' : 'before finishing'}.
      </p>
      {runs.length === 0 ? (
        <p className="orch-muted">It has not run yet.</p>
      ) : (
        <ul className="orch-check-runs">
          {runs.map((item) => (
            <li key={item.id}>
              <div className="orch-check-line">
                <span className={`orch-check-pill orch-check-pill--${item.outcome}`}>
                  {outcomeLabel[item.outcome]}
                </span>
                {item.exitCode !== null && <span>exit {item.exitCode}</span>}
                <span>{reasonLabel[item.reason]}</span>
                <span className="orch-muted">{when(item.queuedAt)}</span>
                {item.current && <strong>counts for finishing</strong>}
              </div>
              {item.output !== '' && (
                <details>
                  <summary>Output</summary>
                  <pre className="orch-check-output">{item.output}</pre>
                </details>
              )}
            </li>
          ))}
        </ul>
      )}
      {live && (
        // One run at a time: a queued or running one would make another click a conflict.
        <div className="orch-controls">
          <button
            type="button"
            disabled={actions.checkRun.isPending || pending}
            onClick={() => actions.checkRun.mutate(control)}
          >
            {pending ? 'Check running…' : 'Run check'}
          </button>
        </div>
      )}
      {waived ? (
        <p className="orch-check-waived" role="status" data-protected="block">
          You let it finish without a passing check <small>{when(check.waivedAt as string)}</small>
        </p>
      ) : (
        live && (
          <div className="orch-check-waive" data-protected="block">
            <p className="orch-muted">
              The job can only finish as a success after the check passes. Only you can change that.
            </p>
            <button
              type="button"
              className="orch-danger"
              disabled={actions.checkWaive.isPending}
              onClick={() => actions.checkWaive.mutate(control)}
            >
              Finish without a passing check
            </button>
          </div>
        )
      )}
      {error ? (
        <p role="alert" className="orch-error">
          {describeOrchError(error)}
        </p>
      ) : null}
    </section>
  )
}
