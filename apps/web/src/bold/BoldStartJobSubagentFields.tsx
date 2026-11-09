import { SUBAGENT_LIMITS } from '@score/contract'
import { SUBAGENT_AT_ONCE_CHOICES } from './start-job-subagents.ts'
import type { StartJobView } from './use-start-job-view.ts'
import './bold-start-subagents.css'

/**
 * The Subagents choice (SA.3, mock-up 24): Off, or up to N at once (the lead's own limit caps it), and the job's total,
 * after which the job pauses and asks. A program Score can't govern says so instead of offering a limit.
 */
export function SubagentFields({ view }: { view: StartJobView }) {
  const lead = view.leadAgent?.name ?? 'The lead'
  const control = view.subagentsCeiling?.control
  const ceilingMax = view.subagentsCeiling?.maxConcurrent ?? SUBAGENT_LIMITS.maxConcurrent
  const choose = (on: boolean, at?: number) => {
    view.setSubagentsOn(on)
    if (at !== undefined) view.setSubagentsAt(at)
    view.touch()
  }
  return (
    <>
      <span className="small muted" id="start-subagents-help">
        The lead can split work among helpers of its own. They don’t join the chat.
      </span>
      {view.subagentsLoading && <span className="small muted">Reading {lead}’s settings…</span>}
      {view.subagentsError && (
        <span className="small muted" role="status">
          Couldn’t read {lead}’s subagent settings. The job uses the agent’s own limits.
        </span>
      )}
      {control === 'none' && <span className="small">Subagents aren’t supported here yet.</span>}
      {(control === 'limits' || control === 'on_off') && (
        <div className="bold-subagent-pills" role="radiogroup" aria-label="Subagents">
          <button
            type="button"
            role="radio"
            aria-checked={!view.subagentsOn}
            className="bold-subagent-pill"
            onClick={() => choose(false)}
          >
            Off
          </button>
          {control === 'on_off' ? (
            <button
              type="button"
              role="radio"
              aria-checked={view.subagentsOn}
              className="bold-subagent-pill"
              onClick={() => choose(true)}
            >
              On
            </button>
          ) : (
            SUBAGENT_AT_ONCE_CHOICES.map((count) => (
              <button
                key={count}
                type="button"
                role="radio"
                aria-checked={view.subagentsOn && view.subagentsAtNow === count}
                disabled={view.subagentsLoading || count > ceilingMax}
                className="bold-subagent-pill"
                onClick={() => choose(true, count)}
              >
                {count}
              </button>
            ))
          )}
        </div>
      )}
      {control === 'limits' && (
        <span className="small muted">
          At once. {lead}’s limit is {ceilingMax}; set in its settings.
        </span>
      )}
      {control === 'on_off' && (
        <span className="small muted">
          Claude Code decides how many run at once; {lead}’s settings say if it may.
        </span>
      )}
      {view.subagentsOn && (control === 'limits' || control === 'on_off') && (
        <label className="bold-subagent-total">
          <span>Total in this job</span>
          <input
            className="field"
            inputMode="numeric"
            aria-label="Total subagents in this job"
            aria-invalid={!view.subagentsTotalValid}
            value={view.subagentsTotal}
            onChange={(event) => {
              view.setSubagentsTotal(event.target.value)
              view.touch()
            }}
          />
          <span className="small muted">then the job pauses and asks you</span>
        </label>
      )}
      {view.subagentsProblem && (
        <span className="small" role="alert">
          {view.subagentsProblem}
        </span>
      )}
    </>
  )
}
