import { ORCH_LIMITS } from '@score/contract'
import { sourceName } from '../routes/orchestrations/decision-parts.tsx'
import type { StartJobView } from './use-start-job-view.ts'

export function LimitsFields({ view }: { view: StartJobView }) {
  return (
    <>
      <span className="lab">{view.isSavedRecipe ? 'Budget and deadline' : 'Limits'}</span>
      {view.isLead && (
        <label className="check small">
          <input
            type="checkbox"
            checked={view.untilStoppedChoice}
            onChange={(event) => {
              view.setUntilStopped(event.target.checked)
              view.touch()
            }}
          />
          Keep going until I stop it
        </label>
      )}
      {view.untilStopped && (
        <span className="small muted">
          No step or turn limit: the lead keeps planning until the work is done, you press Stop, or
          the spend cap is reached.
        </span>
      )}
      {!view.isSavedRecipe && !view.untilStopped && (
        <>
          <label htmlFor="start-turns" className="row small">
            <span className="grow">Turns per back-and-forth</span>
            <b>{view.turns}</b>
          </label>
          <input
            id="start-turns"
            type="range"
            min={2}
            max={20}
            value={view.turns}
            onChange={(event) => {
              view.setTurns(Number(event.target.value))
              view.touch()
            }}
            style={{ accentColor: 'var(--ink)' }}
          />
        </>
      )}
      <label htmlFor="start-cap" className="row small">
        <span className="grow">Spend cap{view.untilStopped ? ' (required)' : ''}</span>
        <b>{view.cap > 0 ? `$${view.cap.toFixed(2)}` : 'No cap'}</b>
      </label>
      <input
        id="start-cap"
        type="range"
        required={view.untilStopped}
        aria-invalid={view.capProblem !== null}
        min={0}
        max={20}
        value={view.cap}
        onChange={(event) => {
          view.setCap(Number(event.target.value))
          view.touch()
        }}
        style={{ accentColor: 'var(--ink)' }}
      />
      {view.capProblem && (
        <span className="small" role="alert">
          {view.capProblem}
        </span>
      )}
      {view.isSavedRecipe && view.cap > 0 && (
        <span className="small muted">
          With a spend cap, a step whose cost Hermes doesn’t report pauses the run so you can
          decide.
        </span>
      )}
      {view.showDeadline && (
        <div className="start-deadline-block">
          <div className="row small">
            <span className="grow">Deadline</span>
            <b>{view.deadlineEnabled ? view.deadline || 'Pick a date and time' : 'No deadline'}</b>
          </div>
          <label className="check small">
            <input
              type="checkbox"
              checked={view.deadlineEnabled}
              onChange={(event) => {
                view.setDeadlineEnabled(event.target.checked)
                view.touch()
              }}
            />
            Set a deadline
          </label>
          {view.deadlineEnabled && (
            <input
              id="start-deadline"
              type="datetime-local"
              className="field"
              aria-label="Deadline date and time"
              value={view.deadline}
              onChange={(event) => {
                view.setDeadline(event.target.value)
                view.touch()
              }}
            />
          )}
          <span className="small muted">If the deadline passes, the run stops.</span>
        </div>
      )}
      {view.isPlain && (
        <span className="small muted">A plain job has no plan to approve and no run deadline.</span>
      )}
    </>
  )
}

export function MoreOptionsFields({ view }: { view: StartJobView }) {
  return (
    <div className="start-clear">
      <label className="start-field">
        <span>Steps at the same time (1 to 3)</span>
        <input
          className="field"
          type="number"
          min={1}
          max={3}
          value={
            view.concurrent ?? String(view.workflowPreflight.data?.defaults.maxConcurrentSteps ?? 2)
          }
          aria-invalid={!view.concurrentValid}
          onChange={(event) => {
            view.setConcurrent(event.target.value)
            view.touch()
          }}
        />
      </label>
      <label className="start-field">
        <span>Estimate per step (USD)</span>
        <input
          className="field"
          type="number"
          min={0.01}
          step={0.01}
          value={
            view.estimate ?? String(view.workflowPreflight.data?.defaults.stepEstimateUsd ?? 0.5)
          }
          aria-invalid={!view.estimateValid}
          onChange={(event) => {
            view.setEstimate(event.target.value)
            view.touch()
          }}
        />
      </label>
      {view.workflowWorkers.length > 0 && (
        <>
          <label className="start-field">
            <span>Most coding steps</span>
            <input
              className="field"
              type="number"
              min={1}
              max={ORCH_LIMITS.maxCodingSteps}
              value={
                view.codingSteps ?? String(view.workflowPreflight.data?.defaults.codingSteps ?? 1)
              }
              aria-invalid={!view.codingStepsValid}
              onChange={(event) => {
                view.setCodingSteps(event.target.value)
                view.touch()
              }}
            />
          </label>
          <label className="start-field">
            <span>Quota floor (%): leave blank to use each coding agent’s own</span>
            <input
              className="field"
              type="number"
              min={0}
              max={50}
              inputMode="numeric"
              value={view.quotaFloor}
              aria-invalid={!view.quotaFloorValid}
              onChange={(event) => {
                view.setQuotaFloor(event.target.value)
                view.touch()
              }}
            />
          </label>
        </>
      )}
    </div>
  )
}

export function StartJobUnknownCost({ view }: { view: StartJobView }) {
  return (
    <fieldset className="inner start-unknown" data-protected="block">
      <legend className="lab start-legend">When Hermes doesn’t say what a step cost</legend>
      <div className="start-clear">
        <label className="check small">
          <input
            type="radio"
            name="start-unknown"
            checked={view.unknownSpend === 'pause'}
            onChange={() => {
              view.setUnknownSpend('pause')
              view.touch()
            }}
          />
          Pause the run and ask me (when a budget is set)
        </label>
        <label className="check small">
          <input
            type="radio"
            name="start-unknown"
            checked={view.unknownSpend === 'continue'}
            onChange={() => {
              view.setUnknownSpend('continue')
              view.touch()
            }}
          />
          Keep going (unknown spend is never counted as zero)
        </label>
        {view.workflowPreflight.data && (
          <span className="small muted">{view.workflowPreflight.data.spendNote}</span>
        )}
        {view.unknownSpend === 'pause' &&
          [...new Set(view.workflowWorkers.map((worker) => worker.runtime))].map((source) => (
            <label key={source} className="check small">
              <input
                type="checkbox"
                checked={view.unknownCost.includes(source)}
                onChange={(event) => {
                  view.setUnknownCost((list) =>
                    event.target.checked
                      ? [...list, source]
                      : list.filter((item) => item !== source),
                  )
                  view.touch()
                }}
              />
              Keep going when the cost of {sourceName(source)} is unknown
            </label>
          ))}
      </div>
    </fieldset>
  )
}

export function StartJobInputs({ view }: { view: StartJobView }) {
  if (!view.workflowDefinition?.inputs.length) return null
  return (
    <fieldset className="inner start-inputs">
      <legend className="lab start-legend">Inputs</legend>
      {view.workflowDefinition.inputs.map((input) => (
        <label key={input.name} className="start-field">
          <span>
            {input.label}
            {input.required ? '' : ' (optional)'}
          </span>
          <textarea
            className="field"
            rows={input.maxChars > 200 ? 3 : 1}
            maxLength={input.maxChars}
            required={input.required}
            value={view.inputs[input.name] ?? ''}
            onChange={(event) => {
              view.setInputs((current) => ({ ...current, [input.name]: event.target.value }))
              view.touch()
            }}
          />
        </label>
      ))}
    </fieldset>
  )
}
