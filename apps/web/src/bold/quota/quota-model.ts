import type { CodingQuota, CodingQuotaWindow } from '@score/contract'
import {
  footerWindows,
  freshQuota,
  leftExact,
  missingText,
  leftPercent,
  primaryQuotaWindow,
  quotaBelowFloor,
  quotaTone,
  type QuotaFloorHit,
  type QuotaTone,
} from '../../routes/team/quota-view.ts'

/** What the chat knows about the agent's floor: still loading, unreadable (list failed or agent missing), or a number. */
export type QuotaFloor =
  { kind: 'loading' } | { kind: 'unreadable' } | { kind: 'known'; percent: number }

export type QuotaPhase = 'loading' | 'error' | 'none' | 'empty' | 'ready'

export type AgentQuotaView = {
  phase: QuotaPhase
  quota: CodingQuota | null
  floor: QuotaFloor
  /** The window below the agent's floor now (reset still ahead), null when none or when the floor is unknown. */
  below: QuotaFloorHit | null
  /** The windows the footer shows: the agent's own model group for Antigravity, all of them otherwise. */
  footer: CodingQuotaWindow[]
  /** The Antigravity model group the footer is about; null for the other CLIs. */
  group: string | null
  primary: CodingQuotaWindow | null
  now: Date
}

export function buildQuotaView(input: {
  quota: CodingQuota | null | undefined
  /** The latest read failed: the old reading, if any, is no longer shown. */
  failed: boolean
  pending: boolean
  floor: QuotaFloor
  /** The coding agent's own model (null = none: Score's default group), never the summary's display id. */
  model: string | null
  now: Date
}): AgentQuotaView {
  const { floor, now } = input
  const quota = input.quota ? freshQuota(input.quota, now) : input.quota
  let phase: QuotaPhase
  if (input.failed) phase = 'error'
  else if (input.pending || quota === undefined) phase = 'loading'
  else if (quota === null) phase = 'none'
  else phase = quota.windows.length === 0 ? 'empty' : 'ready'
  const shown = phase === 'ready' ? (quota ?? null) : null
  const part = shown ? footerWindows(shown, input.model) : { group: null, windows: [] }
  return {
    phase,
    quota: shown,
    floor,
    below:
      shown && floor.kind === 'known'
        ? quotaBelowFloor(shown, floor.percent, now, input.model)
        : null,
    footer: part.windows,
    group: part.group,
    primary: primaryQuotaWindow(part.windows),
    now,
  }
}

/** The pill's windows: the primary one, then the week when that is another window (at most two, even on a phone). */
export function pillWindows(view: AgentQuotaView): CodingQuotaWindow[] {
  const { primary } = view
  if (!primary) return []
  const week = view.footer.find((window) => window !== primary && window.name === 'week')
  return week ? [primary, week] : [primary]
}

/** Red only for the window that is below the floor; amber under 25% left; otherwise plain. */
export function windowToneOf(
  window: CodingQuotaWindow,
  below: QuotaFloorHit | null,
): QuotaTone | 'out' {
  if (below && below.window === window) return 'out'
  return quotaTone(leftExact(window))
}

const spoken = (window: CodingQuotaWindow): string => {
  const left = leftPercent(window)
  const when = window.name === 'week' ? 'this week' : 'in 5 hours'
  return left === null ? `${missingText(window)} ${when}` : `${left}% left ${when}`
}

/** Plain words for the pill's accessible name: the values, not just that there is a quota. */
export function pillLabel(view: AgentQuotaView, plan: string, read: string | null): string {
  if (view.below)
    return `${plan} quota: ${view.below.leftPercent}% left, below its ${
      view.floor.kind === 'known' ? view.floor.percent : 0
    }% floor`
  const windows = pillWindows(view)
  if (windows.length === 0) return `${plan} quota`
  const group = view.group ? `${view.group}: ` : ''
  return `${plan} quota: ${group}${windows.map(spoken).join(', ')}${read ? `, ${read}` : ''}`
}
