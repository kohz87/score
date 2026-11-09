import { ORCH_LIMITS } from '@score/contract'
import type { StartJobView } from './use-start-job-view.ts'

export function StartJobLaunches({ view }: { view: StartJobView }) {
  return (
    <div className="start-field start-launches" data-protected="block">
      <label htmlFor="start-launches-input">Coding-agent launches (1–100)</label>
      <input
        id="start-launches-input"
        className="field"
        type="number"
        min={1}
        max={ORCH_LIMITS.maxCodingSteps}
        value={view.launchesNow}
        aria-invalid={!view.launchesValid}
        aria-describedby="start-launches-help"
        onChange={(event) => {
          view.setLaunchesText(event.target.value)
          view.touch()
        }}
      />
      <span className="small muted" id="start-launches-help">
        Each step, helper step, vote answer and advisor consult on a coding agent is one launch.
      </span>
      {view.launchesProblem && (
        <span className="small" role="alert">
          {view.launchesProblem}
        </span>
      )}
    </div>
  )
}
