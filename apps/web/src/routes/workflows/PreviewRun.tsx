import type { AgentSummary } from '@score/contract'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  LiveDiagram,
  useEffectPlayer,
  usePrefersReducedMotion,
} from '../orchestrations/LiveDiagram.tsx'
import type { NodeVisual } from '../orchestrations/orch-model.ts'
import { defaultChoice, startPreview, stepPreview, type PreviewState } from './preview-stepper.ts'
import type { Draft } from './workflow-model.ts'
import { buildWorkflowGraph } from './workflow-run-model.ts'

// PLAN 5.39: "Preview" plays the drawn workflow through the live diagram. Nothing runs and no model is called: the
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
  const reducedMotion = usePrefersReducedMotion()
  const [speed, setSpeed] = useState<Speed>(1)
  const quiet = reducedMotion || speed > 1
  const player = useEffectPlayer(quiet)
  const [state, setState] = useState<PreviewState>(() => startPreview(draft))
  const [branch, setBranch] = useState<string | null>(null)
  const { enqueue, reset: resetPlayer } = player
  const sentFirst = useRef(false)
  useEffect(() => {
    // The first state has its own pulse on the steps that start.
    if (sentFirst.current) return
    sentFirst.current = true
    enqueue([...state.effects])
  }, [enqueue, state.effects])

  const advance = (choice?: string) => {
    const next = stepPreview(state, draft, choice)
    enqueue([...next.effects])
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

  const graph = useMemo(() => buildWorkflowGraph(draft), [draft])
  const positions = useMemo(
    () => new Map(Object.entries(draft.layout?.nodes ?? {})),
    [draft.layout],
  )
  const statuses = useMemo(() => {
    const map = new Map<string, string>()
    for (const [id, visual] of state.nodes) if (visual === 'running') map.set(id, 'Previewing…')
    return map
  }, [state.nodes])
  const nodes = useMemo(
    () =>
      graph.nodes.map((node) =>
        statuses.has(node.id) ? { ...node, status: statuses.get(node.id)! } : node,
      ),
    [graph.nodes, statuses],
  )
  const visuals: ReadonlyMap<string, NodeVisual> = state.nodes
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
                resetPlayer()
                const first = startPreview(draft)
                setState(first)
                enqueue([...first.effects])
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

      <div className="orch-diagram">
        <LiveDiagram
          nodes={nodes}
          edges={graph.edges}
          visuals={visuals}
          lead="idle"
          agents={agents}
          selected={null}
          onSelect={() => {}}
          active={player.active}
          reducedMotion={quiet}
          edgeStates={state.edges}
          positions={positions}
          noun="Step"
          ariaLabel="Preview of the workflow. Nothing runs."
          columnGap={84}
        />
      </div>
    </section>
  )
}
