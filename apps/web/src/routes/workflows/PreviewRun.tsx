import type { AgentSummary } from '@score/contract'
import { useEffect, useMemo, useRef, useState } from 'react'
import { defaultChoice, startPreview, stepPreview, type PreviewState } from './preview-stepper.ts'
import { RecipeLayers, type CardState } from './RecipeLayers.tsx'
import type { Draft } from './workflow-model.ts'
import { indexIssues } from './workflow-validation.ts'

// PLAN 5.39: "Preview" plays the drawn workflow through the recipe's layered view (3.26.0). Nothing runs and no model is called: the
// walk is pure client code (preview-stepper.ts). It waits at a gate and at a branch for the person to choose.

type Speed = 1 | 4
/** How long a step takes at 1×; 4× goes four times as fast and shows highlights instead of travelling dots. */
const STEP_MS = 1300

export const PREVIEW_LABEL = 'Preview: nothing runs, no tokens'

export function WorkflowPreview({
  draft,
  agents,
  onStop,
}: {
  /** The draft as it was when the preview started: editing it elsewhere doesn't change a preview under way. */
  draft: Draft
  agents: AgentSummary[]
  onStop: () => void
}) {
  const [speed, setSpeed] = useState<Speed>(1)
  const [state, setState] = useState<PreviewState>(() => startPreview(draft))
  const [branch, setBranch] = useState<string | null>(null)

  const advance = (choice?: string) => {
    const next = stepPreview(state, draft, choice)
    setBranch(null)
    setState(next)
  }
  const advanceRef = useRef(advance)
  useEffect(() => {
    advanceRef.current = advance
  })
  // While nothing waits for an answer, the preview moves on by itself.
  useEffect(() => {
    if (state.status !== 'running') return
    const timer = window.setTimeout(() => advanceRef.current(), STEP_MS / speed)
    return () => window.clearTimeout(timer)
  }, [state, speed])

  // The states of the steps, drawn on each card of the layered view; a running step says it is previewing.
  const cards = useMemo(() => {
    const map = new Map<string, CardState>()
    for (const [id, visual] of state.nodes)
      map.set(id, visual === 'running' ? { visual, status: 'Previewing…' } : { visual })
    return map
  }, [state.nodes])
  const noIssues = useMemo(() => indexIssues([]), [])
  const pause = state.pause
  const label = (id: string) => draft.nodes.find((node) => node.id === id)?.label ?? id
  const question =
    pause?.kind === 'gate'
      ? (() => {
          const node = draft.nodes.find((item) => item.id === pause.nodeId)
          return node?.kind === 'gate' ? node.question : ''
        })()
      : ''
  const chosen = pause?.kind === 'branch' ? (branch ?? defaultChoice(pause)) : null
  const finished = state.status === 'done' || state.status === 'stopped'

  return (
    <section className="wf-preview" aria-label="Preview">
      <div className="wf-preview__bar">
        <strong className="wf-preview__label">{PREVIEW_LABEL}</strong>
        <div className="wf-preview__controls">
          <div role="group" aria-label="Preview speed" className="wf-preview__speed">
            {([1, 4] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={speed === value}
                onClick={() => setSpeed(value)}
              >
                {value}×
              </button>
            ))}
          </div>
          {finished && (
            <button
              type="button"
              onClick={() => {
                setBranch(null)
                setState(startPreview(draft))
              }}
            >
              Play again
            </button>
          )}
          <button type="button" className="orch-primary" onClick={onStop}>
            Stop
          </button>
        </div>
      </div>

      <div className="wf-preview__ask" role="status" aria-live="polite">
        {pause?.kind === 'gate' && (
          <div
            data-protected="block"
            className="orch-decision wf-preview__card"
            aria-label={`Preview: ${label(pause.nodeId)}`}
          >
            <h3>
              {label(pause.nodeId)} <small>The preview is waiting at this gate</small>
            </h3>
            {question && <p className="orch-quote">{question}</p>}
            <div className="orch-actions">
              <button type="button" className="orch-primary" onClick={() => advance('ok')}>
                Continue as approved
              </button>
              <button type="button" onClick={() => advance('rejected')}>
                Continue as rejected
              </button>
              <span className="orch-muted">
                {pause.onReject === 'stop_run'
                  ? 'Rejecting stops the run.'
                  : 'Rejecting follows the “rejected” path.'}
              </span>
            </div>
          </div>
        )}
        {pause?.kind === 'branch' && (
          <div
            data-protected="block"
            className="orch-decision wf-preview__card"
            aria-label={`Preview: ${label(pause.nodeId)}`}
          >
            <h3>
              {label(pause.nodeId)} <small>Which outcome should the preview follow?</small>
            </h3>
            <fieldset className="wf-preview__options">
              <legend className="wf-visually-hidden">Outcome to follow</legend>
              {pause.options.map((option) => (
                <label key={option.port} className="orch-check">
                  <input
                    type="radio"
                    name="preview-branch"
                    checked={chosen === option.port}
                    onChange={() => setBranch(option.port)}
                  />
                  {option.label}
                </label>
              ))}
            </fieldset>
            <div className="orch-actions">
              <button type="button" className="orch-primary" onClick={() => advance(chosen!)}>
                Continue
              </button>
            </div>
          </div>
        )}
        {finished && (
          <p className="wf-preview__done">
            {state.status === 'stopped'
              ? 'Preview ended: the gate was rejected and rejecting stops the run. Nothing ran.'
              : 'Preview finished. Nothing ran.'}
          </p>
        )}
      </div>

      <RecipeLayers
        draft={draft}
        agents={agents}
        issues={noIssues}
        selected={null}
        onSelect={() => {}}
        states={cards}
        readOnly
        ariaLabel="Preview of the recipe. Nothing runs."
      />
    </section>
  )
}
