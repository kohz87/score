import { SUBAGENT_LIMITS } from '@score/contract'
import { useRef, type KeyboardEvent } from 'react'
import { SUBAGENT_AT_ONCE_CHOICES } from './start-job-subagents.ts'
import type { StartJobView } from './use-start-job-view.ts'
import './bold-start-subagents.css'

type Pill = { key: string; label: string; checked: boolean; disabled: boolean; choose: () => void }

const STEP: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }

/**
 * The Subagents choice (SA.3, mock-up 24): Off, or up to N at once (the lead's own limit caps it), and the job's total,
 * after which the job pauses and asks. A program Score can't govern says so instead of offering a limit.
 */
export function SubagentFields({ view }: { view: StartJobView }) {
  const lead = view.leadAgent?.name ?? 'The lead'
  const control = view.subagentsCeiling?.control
  const ceilingMax = view.subagentsCeiling?.maxConcurrent ?? SUBAGENT_LIMITS.maxConcurrent
  const pillRefs = useRef<(HTMLButtonElement | null)[]>([])
  const choose = (on: boolean, at?: number) => {
    view.setSubagentsOn(on)
    if (at !== undefined) view.setSubagentsAt(at)
    view.touch()
  }
  const pills: Pill[] = [
    {
      key: 'off',
      label: 'Off',
      checked: !view.subagentsOn,
      disabled: false,
      choose: () => choose(false),
    },
    ...(control === 'on_off'
      ? [
          {
            key: 'on',
            label: 'On',
            checked: view.subagentsOn,
            disabled: false,
            choose: () => choose(true),
          },
        ]
      : SUBAGENT_AT_ONCE_CHOICES.map((count) => ({
          key: String(count),
          label: String(count),
          checked: view.subagentsOn && view.subagentsAtNow === count,
          disabled: view.subagentsLoading || count > ceilingMax,
          choose: () => choose(true, count),
        }))),
  ]
  // Roving tabIndex: the checked pill is the one Tab reaches; with none checked, the first enabled one is.
  const enabled = pills.flatMap((pill, index) => (pill.disabled ? [] : [index]))
  const tabStop = pills.findIndex((pill) => pill.checked && !pill.disabled)
  const stop = tabStop >= 0 ? tabStop : (enabled[0] ?? -1)

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const step = STEP[event.key]
    if (step === undefined) return
    event.preventDefault()
    let next = index
    for (let turn = 0; turn < pills.length; turn++) {
      next = (next + step + pills.length) % pills.length
      if (!pills[next]!.disabled) break
    }
    if (next === index || pills[next]!.disabled) return
    pillRefs.current[next]?.focus()
    pills[next]!.choose()
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
          {pills.map((pill, index) => (
            <button
              key={pill.key}
              ref={(element) => {
                pillRefs.current[index] = element
              }}
              type="button"
              role="radio"
              aria-checked={pill.checked}
              tabIndex={index === stop ? 0 : -1}
              disabled={pill.disabled}
              className="bold-subagent-pill"
              onClick={pill.choose}
              onKeyDown={(event) => onKeyDown(event, index)}
            >
              {pill.label}
            </button>
          ))}
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
