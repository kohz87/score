import type { AgentContext, AgentSummary, CodingQuota, CodingRuntime } from '@score/contract'
import {
  leftExact,
  leftPercent,
  planLabel,
  quotaReadLine,
  quotaTone,
  resetText,
  windowTitle,
  missingText,
  freshQuota,
} from '../team/quota-view.ts'
import { compact } from './context-meter.ts'

export type UsageCardWindow = {
  title: string
  /** Rounded share for the words; null = the CLI didn't say (no bar). */
  left: number | null
  /** What stands in for the share when there is none ("not reported", "reset since it was read"). */
  missing: string
  /** Unrounded share for the bar. */
  exact: number | null
  tone: 'ok' | 'low'
  resets: string | null
}

export type UsageCardQuota =
  { kind: 'message'; text: string } | { kind: 'windows'; windows: UsageCardWindow[]; read: string }

/** The `/usage` (and `/status`) answer of a coding agent as the mock-up's card (30-quota-usage). */
export type UsageCardData = {
  agent: AgentSummary | undefined
  name: string
  /** "182k tokens", or null when the agent reported none. */
  tokens: string | null
  contextPercent: number | null
  /** Only when the agent's context reports a dollar cost; otherwise the card says it is plan usage. */
  costUsd: number | null
  planTitle: string
  quota: UsageCardQuota
}

export function buildUsageCard(
  agent: AgentSummary | undefined,
  name: string,
  context: AgentContext,
  quota: CodingQuota | null | undefined,
  runtime: CodingRuntime,
  now = new Date(),
): UsageCardData {
  const used = context.tokens ? context.tokens.input + context.tokens.output : null
  const reading = quota ? freshQuota(quota, now) : quota
  let part: UsageCardQuota
  if (reading === undefined) part = { kind: 'message', text: 'Quota couldn’t be read.' }
  else if (reading === null) part = { kind: 'message', text: 'Quota · shows after its first turn.' }
  else if (reading.windows.length === 0) part = { kind: 'message', text: 'Quota · not reported.' }
  else
    part = {
      kind: 'windows',
      read: quotaReadLine(reading, now),
      windows: reading.windows.map((window) => ({
        title: windowTitle(window),
        left: leftPercent(window),
        missing: missingText(window),
        exact: leftExact(window),
        tone: quotaTone(leftExact(window)),
        resets: resetText(window.resetsAt, now),
      })),
    }
  return {
    agent,
    name,
    tokens: used === null ? null : `${compact(used)} tokens`,
    contextPercent:
      used !== null && context.contextLength
        ? Math.min(100, Math.round((used / context.contextLength) * 100))
        : null,
    costUsd: context.costUsd,
    planTitle: `${planLabel(runtime).toUpperCase()} QUOTA`,
    quota: part,
  }
}
