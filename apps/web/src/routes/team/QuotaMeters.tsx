import {
  CodingQuotaResponseSchema,
  type CodingQuota,
  type CodingQuotaWindow,
  type CodingRuntime,
} from '@score/contract'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '../../data/api.ts'
import { runtimeLabel } from '../../components/runtime-label.ts'
import { leftPercent, resetText, seenText } from './quota-view.ts'

export { leftPercent, resetText, seenText } from './quota-view.ts'

const windowLabel = (window: CodingQuotaWindow): string =>
  window.group ? `${window.group}, ${window.name}` : window.name
const level = (left: number | null): 'plenty' | 'low' | 'out' =>
  left === null || left > 25 ? 'plenty' : left > 10 ? 'low' : 'out'

function Meter({ window, floor }: { window: CodingQuotaWindow; floor?: number | undefined }) {
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
        aria-valuetext={`${left === null ? 'unknown' : `${left}% left`}${floor ? `, runs stop using this agent below ${floor}%` : ''}`}
      >
        <span className="quota-fill" data-level={level(left)} style={{ width: `${left ?? 0}%` }} />
        {floor ? <span className="quota-floor" style={{ left: `${floor}%` }} aria-hidden /> : null}
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
  floor,
}: {
  runtime: CodingRuntime
  quota: CodingQuota | null
  /** The agent's floor (PLAN 8.6): marked on each bar. */
  floor?: number
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
          <Meter key={`${window.group ?? ''}|${window.name}`} window={window} floor={floor} />
        ))}
      </ul>
      {floor || quota.source !== 'usage' ? (
        <div className="quota-notes">
          {floor ? (
            <p className="team-muted quota-seen">
              The red mark is the floor: runs stop giving this agent new steps below {floor}% left.
            </p>
          ) : null}
          {quota.source !== 'usage' && (
            <p className="team-muted quota-seen">As of {seenText(quota.seenAt)}.</p>
          )}
        </div>
      ) : null}
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

export const codingAgentQuotaPath = (agentId: string) =>
  `coding-agents/${encodeURIComponent(agentId)}/quota`

export async function fetchCodingAgentQuota(
  agentId: string,
  signal?: AbortSignal,
): Promise<CodingQuota | null> {
  return CodingQuotaResponseSchema.parse(
    await apiFetch(codingAgentQuotaPath(agentId), signal ? { signal } : {}),
  ).quota
}

/** The query the chat's footer, Info and /usage share for one agent. */
export const codingAgentQuotaQuery = (agentId: string) => ({
  queryKey: ['coding', 'quota', agentId] as const,
  queryFn: ({ signal }: { signal: AbortSignal }) => fetchCodingAgentQuota(agentId, signal),
  retry: false,
  staleTime: 30_000,
})

export function useCodingQuota(
  path: string,
  key: readonly unknown[],
  options: { refetchInterval?: number; enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: ['coding', 'quota', ...key],
    queryFn: async ({ signal }) =>
      CodingQuotaResponseSchema.parse(await apiFetch(path, { signal })).quota,
    retry: false,
    staleTime: 30_000,
    enabled: options.enabled ?? true,
    refetchInterval: options.refetchInterval ?? false,
    refetchIntervalInBackground: false,
  })
}

/** The meters of one coding agent (its page). */
export function AgentQuota({
  agentId,
  runtime,
  floor,
}: {
  agentId: string
  runtime: CodingRuntime
  floor?: number
}) {
  const quota = useCodingQuota(`coding-agents/${encodeURIComponent(agentId)}/quota`, [agentId])
  if (quota.isPending) return <p className="team-muted">Reading the limits…</p>
  if (quota.error)
    return <p className="team-muted">Couldn’t read the limits: {quota.error.message}</p>
  return <QuotaMeters runtime={runtime} quota={quota.data} {...(floor ? { floor } : {})} />
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
