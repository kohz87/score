import type { AgentSummary, CodingQuotaWindow, CodingRuntime } from '@score/contract'
import { Fragment } from 'react'
import {
  leftExact,
  leftPercent,
  planLabel,
  quotaReadLine,
  quotaTone,
  resetText,
  shortWindow,
  missingText,
} from '../../routes/team/quota-view.ts'
import { pillLabel, pillWindows, type AgentQuotaView } from './quota-model.ts'
import { useAgentQuota } from './use-agent-quota.ts'
import './bold-quota.css'

const percent = (value: number): string =>
  Number.isInteger(value) ? String(value) : value.toFixed(1)

function Track({ left, tone }: { left: number; tone: string }) {
  return (
    <span className="bold-quota-track" data-tone={tone} aria-hidden="true">
      <span className="bold-quota-fill" style={{ width: `${left}%` }} />
    </span>
  )
}

/** The words that stand in for a bar: no reading yet, a failed read, nothing the CLI reported. */
function idleText(view: AgentQuotaView, runtime: CodingRuntime): string {
  if (view.phase === 'loading') return 'reading…'
  if (view.phase === 'error') return 'couldn’t be read'
  if (view.phase === 'none' && runtime !== 'antigravity') return 'shows after its first turn'
  // Every window it shows has reset since the reading (3.38.1): say that, not "not reported".
  const reset = view.footer.map(missingText)
  if (reset.length > 0 && reset.every((text) => text !== 'not reported')) return reset[0]!
  return 'not reported'
}

function Share({ window }: { window: CodingQuotaWindow }) {
  const left = leftPercent(window)
  if (left === null)
    return (
      <>
        <span className="bold-quota-window">{shortWindow(window)}</span>
        <span className="bold-quota-idle">{missingText(window)}</span>
      </>
    )
  return (
    <>
      <b>{left}%</b>
      <span className="bold-quota-window">{shortWindow(window)}</span>
    </>
  )
}

function NormalPill({ view }: { view: AgentQuotaView }) {
  const [primary, ...rest] = pillWindows(view)
  const left = primary ? leftExact(primary) : null
  if (!primary || left === null) return null
  const tone = quotaTone(left)
  const resets = resetText(primary.resetsAt, view.now)
  return (
    <>
      <span className="bold-quota-label">Quota</span>
      {view.group && <span className="bold-quota-group">{view.group}</span>}
      <Track left={left} tone={tone} />
      <b>
        {leftPercent(primary)}%<span className="bold-quota-left-word"> left</span>
      </b>
      <span className="bold-quota-window">{shortWindow(primary)}</span>
      {tone === 'low' && resets ? (
        <>
          <span className="bold-quota-sep">·</span>
          <span className="bold-quota-reset">resets {resets}</span>
        </>
      ) : (
        rest.map((window) => (
          <Fragment key={`${window.group ?? ''}|${window.name}`}>
            <span className="bold-quota-sep">·</span>
            <Share window={window} />
          </Fragment>
        ))
      )}
    </>
  )
}

/**
 * The coding agent's plan quota under the composer (decision 186): the 5-hour window as a bar, then the week's own
 * percentage. It opens Chat info; the reading is the same query Chat info uses.
 */
export function QuotaPill({
  agent,
  runtime,
  onOpen,
}: {
  agent: AgentSummary
  runtime: CodingRuntime
  onOpen: () => void
}) {
  const view = useAgentQuota(agent, { refresh: true })
  const { below } = view
  const windows = pillWindows(view)
  const tone = windows.some((window) => quotaTone(leftExact(window)) === 'low') ? 'low' : 'ok'
  const read = view.quota ? quotaReadLine(view.quota, view.now) : null
  const floor = view.floor.kind === 'known' ? view.floor.percent : 0
  const bars = view.phase === 'ready' && view.primary !== null
  const label = bars
    ? pillLabel(view, planLabel(runtime), read)
    : `${planLabel(runtime)} quota, ${idleText(view, runtime)}`

  return (
    <button
      type="button"
      className={`bold-quota-pill${below ? ' bold-quota-floor' : ''}`}
      data-tone={below ? 'out' : tone}
      {...(below ? { 'data-protected': 'inline-flex' } : {})}
      aria-label={label}
      title={label}
      onClick={onOpen}
    >
      {below ? (
        <>
          <Track left={below.leftPercent} tone="out" />
          <b>
            {percent(below.leftPercent)}% left · below its {floor}% floor
          </b>
        </>
      ) : bars ? (
        <NormalPill view={view} />
      ) : (
        <span className="bold-quota-idle">Quota · {idleText(view, runtime)}</span>
      )}
    </button>
  )
}
