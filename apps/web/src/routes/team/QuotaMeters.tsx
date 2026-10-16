import {
  CodingQuotaResponseSchema,
  type CodingQuota,
  type CodingQuotaWindow,
  type CodingRuntime,
} from '@score/contract'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '../../data/api.ts'
import { runtimeLabel } from '../../components/runtime-label.ts'

/** Share still available, 0–100, or null when the CLI didn't say. */
export const leftPercent = (window: CodingQuotaWindow): number | null =>
  window.usedPercent === null
    ? null
    : Math.max(0, Math.min(100, Math.round(100 - window.usedPercent)))

/** "1:46 pm" today, "17 Oct, 1:46 pm" otherwise, in the browser's timezone. */
export function resetText(value: string | null, now = new Date()): string | null {
  if (value === null) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  // ICU puts a narrow no-break space before AM/PM; "1:46 pm" is what people read.
  const time = date
    .toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    .replace(/\s/g, ' ')
    .toLowerCase()
  return date.toDateString() === now.toDateString()
    ? time
    : `${date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}, ${time}`
}

/** When a reading was taken: relative when recent (WRITING.md), absolute otherwise. */
export function seenText(value: string, now = new Date()): string {
  const date = new Date(value)
  const minutes = Math.floor((now.getTime() - date.getTime()) / 60_000)
  if (Number.isNaN(minutes)) return value
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

const windowLabel = (window: CodingQuotaWindow): string =>
  window.group ? `${window.group}, ${window.name}` : window.name
const level = (left: number | null): 'plenty' | 'low' | 'out' =>
  left === null || left > 25 ? 'plenty' : left > 10 ? 'low' : 'out'

function Meter({ window }: { window: CodingQuotaWindow }) {
  const left = leftPercent(window)
  const resets = resetText(window.resetsAt)
  return (
    <li className="quota-row">
      <span className="quota-name">{windowLabel(window)}</span>
      <span
        className="quota-bar"
        role="meter"
        aria-label={`${windowLabel(window)} left`}
        aria-valuemin={0}
        aria-valuemax={100}
        {...(left === null ? {} : { 'aria-valuenow': left })}
        aria-valuetext={left === null ? 'unknown' : `${left}% left`}
      >
        <span className="quota-fill" data-level={level(left)} style={{ width: `${left ?? 0}%` }} />
      </span>
      <span className="quota-left">{left === null ? '?' : `${left}%`} left</span>
      <span className="quota-reset">{resets ? `resets ${resets}` : ''}</span>
    </li>
  )
}

/** A CLI's quota as bars: "% left" and the reset time per window, with when Score saw the numbers. */
export function QuotaMeters({
  runtime,
  quota,
}: {
  runtime: CodingRuntime
  quota: CodingQuota | null
}) {
  const name = runtimeLabel(runtime) ?? runtime
  if (quota === null)
    return (
      <p className="team-muted">
        {runtime === 'antigravity'
          ? 'Antigravity didn’t report its limits.'
          : `${name} reports its limits after its first reply. Nothing yet.`}
      </p>
    )
  if (quota.windows.length === 0)
    return <p className="team-muted">{name} didn’t report limits Score can read.</p>
  return (
    <div className="quota" role="group" aria-label={`${name} limits`}>
      <ul className="quota-list">
        {quota.windows.map((window) => (
          <Meter key={`${window.group ?? ''}|${window.name}`} window={window} />
        ))}
      </ul>
      {quota.source !== 'usage' && (
        <p className="team-muted quota-seen">As of {seenText(quota.seenAt)}.</p>
      )}
    </div>
  )
}

/** One short line for the add-agent form: "5 hours 94% left · week 22% left". */
export function quotaLine(quota: CodingQuota): string {
  return quota.windows
    .map((window) => {
      const left = leftPercent(window)
      return `${windowLabel(window).replace(', ', ' ')} ${left === null ? '?' : `${left}%`} left`
    })
    .join(' · ')
}

export function useCodingQuota(path: string, key: readonly unknown[]) {
  return useQuery({
    queryKey: ['coding', 'quota', ...key],
    queryFn: async ({ signal }) =>
      CodingQuotaResponseSchema.parse(await apiFetch(path, { signal })).quota,
    retry: false,
    staleTime: 30_000,
  })
}

/** The meters of one coding agent (its page). */
export function AgentQuota({ agentId, runtime }: { agentId: string; runtime: CodingRuntime }) {
  const quota = useCodingQuota(`coding-agents/${encodeURIComponent(agentId)}/quota`, [agentId])
  if (quota.isPending) return <p className="team-muted">Reading the limits…</p>
  if (quota.error)
    return <p className="team-muted">Couldn’t read the limits: {quota.error.message}</p>
  return <QuotaMeters runtime={runtime} quota={quota.data} />
}

/** The compact line in the add-agent form: the latest reading for the chosen kind of coding agent. */
export function RuntimeQuotaLine({ runtime }: { runtime: CodingRuntime }) {
  const quota = useCodingQuota(`coding-agents/runtimes/${runtime}/quota`, ['runtime', runtime])
  if (quota.isPending)
    return <p className="team-muted">Reading the {runtimeLabel(runtime) ?? runtime} limits…</p>
  if (quota.error)
    return (
      <p className="team-muted">
        {runtimeLabel(runtime) ?? runtime} limits unavailable: {quota.error.message}
      </p>
    )
  if (quota.data === null || quota.data.windows.length === 0)
    return runtime === 'antigravity' ? (
      <p className="team-muted">Antigravity didn’t report its limits.</p>
    ) : null
  return (
    <p
      className="team-muted"
      role="group"
      aria-label={`${runtimeLabel(runtime) ?? runtime} limits`}
    >
      Limits left: {quotaLine(quota.data)}
    </p>
  )
}
