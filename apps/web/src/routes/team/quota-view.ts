import type { CodingQuota, CodingQuotaWindow, CodingRuntime, Runtime } from '@score/contract'

// A window whose reset time has passed since the reading says nothing about now (owner's live check, 2026-11-12: a
// reading from Oct 28 still showed "7% left this week"). freshQuota drops its share and reset; missingText then says so.
const resetSince = new WeakSet<CodingQuotaWindow>()

/** The reading as of `now`: a window that has reset since it was read keeps its name but loses its share and reset. */
export function freshQuota(quota: CodingQuota, now = new Date()): CodingQuota {
  return {
    ...quota,
    windows: quota.windows.map((window) => {
      const at = window.resetsAt === null ? Number.NaN : Date.parse(window.resetsAt)
      if (!(at <= now.getTime())) return window
      const reset = { ...window, usedPercent: null, resetsAt: null }
      resetSince.add(reset)
      return reset
    }),
  }
}

/** The words for a window without a share: it reset since the reading, or the CLI didn't say. */
export const missingText = (window: CodingQuotaWindow): string =>
  resetSince.has(window) ? 'reset since it was read' : 'not reported'

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

export const isCodingRuntime = (runtime: Runtime | undefined): runtime is CodingRuntime =>
  runtime === 'claude-code' || runtime === 'codex' || runtime === 'antigravity'

const PLAN_LABELS: Record<CodingRuntime, string> = {
  'claude-code': 'Claude plan',
  codex: 'ChatGPT plan',
  antigravity: 'Antigravity',
}

const LOGIN_LABELS: Record<CodingRuntime, string> = {
  'claude-code': 'Claude',
  codex: 'ChatGPT',
  antigravity: 'Antigravity',
}

export const planLabel = (runtime: CodingRuntime): string => PLAN_LABELS[runtime]
export const loginLabel = (runtime: CodingRuntime): string => LOGIN_LABELS[runtime]

/** "5 hours" or "Week", with Antigravity's model group before it. */
export function windowTitle(window: CodingQuotaWindow): string {
  const name = window.name === 'week' ? 'Week' : window.name
  return window.group ? `${window.group}, ${name}` : name
}

/** The compact name in the footer: "5 h" or "week". */
export const shortWindow = (window: CodingQuotaWindow): string =>
  window.name === '5 hours' ? '5 h' : 'week'

/** Share still available, unrounded, 0–100, or null when the CLI didn't say (tones and floors read this, not the rounded text). */
export const leftExact = (window: CodingQuotaWindow): number | null =>
  window.usedPercent === null ? null : Math.max(0, Math.min(100, 100 - window.usedPercent))

/** The first 5-hour window with a known share, else the first with a known share; null when none is known. */
export function primaryQuotaWindow(windows: CodingQuotaWindow[]): CodingQuotaWindow | null {
  const known = windows.filter((window) => window.usedPercent !== null)
  return known.find((window) => window.name === '5 hours') ?? known[0] ?? null
}

export type QuotaTone = 'ok' | 'low'

/** Amber under 25% left. Red belongs only to the below-floor state (`quotaBelowFloor`), never to a tone. */
export function quotaTone(left: number | null): QuotaTone {
  return left !== null && left < 25 ? 'low' : 'ok'
}

export type QuotaFloorHit = {
  window: CodingQuotaWindow
  /** Whole or one-decimal percent still available in that window. */
  leftPercent: number
}

const GEMINI_GROUP = 'Gemini Models'
const ARGON_GROUP = 'Gemini 4 Argon'
const CLAUDE_GPT_GROUP = 'Claude and GPT models'

/** The Antigravity group a model draws on; the same rule as apps/server/src/runtimes/coding/quota-floor.ts. */
export function antigravityGroupOf(model: string | null | undefined): string | null {
  if (model === null || model === undefined || model.trim() === '') return GEMINI_GROUP
  const id = model.trim().toLowerCase()
  if (id.startsWith('gemini-4-argon')) return ARGON_GROUP
  if (id.startsWith('gemini-')) return GEMINI_GROUP
  if (id.startsWith('claude-') || id.startsWith('gpt-')) return CLAUDE_GPT_GROUP
  return null
}

/**
 * The current window below the floor, using the quota guard's rule (PLAN 8.6): known share, reset still ahead, and for
 * Antigravity only the chosen model's group. The web cannot import the server's implementation, so this mirrors it.
 */
export function quotaBelowFloor(
  quota: CodingQuota | null | undefined,
  floor: number,
  now: Date | number,
  model: string | null | undefined,
): QuotaFloorHit | null {
  if (!quota || !(floor > 0)) return null
  const nowMs = typeof now === 'number' ? now : now.getTime()
  const group = quota.runtime === 'antigravity' ? antigravityGroupOf(model) : null
  let worst: QuotaFloorHit | null = null
  for (const window of quota.windows) {
    if (group !== null && (window.group ?? '').toLowerCase() !== group.toLowerCase()) continue
    if (window.usedPercent === null || window.resetsAt === null) continue
    const reset = Date.parse(window.resetsAt)
    if (!Number.isFinite(reset) || reset <= nowMs) continue
    const left = 100 - window.usedPercent
    if (left >= floor) continue
    if (worst === null || left < worst.leftPercent)
      worst = {
        window,
        leftPercent: Math.max(0, Math.round(left * 10) / 10),
      }
  }
  return worst
}

/** "read after the 14:05 turn" (Claude Code, Codex) or "read 3 min ago" (Antigravity). */
export function quotaReadLine(quota: CodingQuota, now = new Date()): string {
  if (quota.runtime === 'antigravity') return `read ${seenText(quota.seenAt, now)}`
  const at = resetText(quota.seenAt, now)
  return at ? `read after the ${at} turn` : `read ${seenText(quota.seenAt, now)}`
}

/** The Chat info sentence: "Read after its 14:05 turn." */
export function quotaReadSentence(quota: CodingQuota, now = new Date()): string {
  if (quota.runtime === 'antigravity') return `Read ${seenText(quota.seenAt, now)}.`
  const at = resetText(quota.seenAt, now)
  return at ? `Read after its ${at} turn.` : `Read ${seenText(quota.seenAt, now)}.`
}

/** The quota windows as lines for /usage: "5 hours 62% left · resets 18:40". */
export function quotaUsageLines(quota: CodingQuota, now = new Date()): string[] {
  return freshQuota(quota, now).windows.map((window) => {
    const left = leftPercent(window)
    const resets = resetText(window.resetsAt, now)
    return `${windowTitle(window)} ${left === null ? missingText(window) : `${left}% left`}${resets ? ` · resets ${resets}` : ''}`
  })
}

/** The windows the footer shows: for Antigravity only the agent's own model group (all when the model maps to none). */
export function footerWindows(
  quota: CodingQuota,
  model: string | null | undefined,
): { group: string | null; windows: CodingQuotaWindow[] } {
  const group = quota.runtime === 'antigravity' ? antigravityGroupOf(model) : null
  if (group === null) return { group: null, windows: quota.windows }
  return {
    group,
    windows: quota.windows.filter(
      (window) => (window.group ?? '').toLowerCase() === group.toLowerCase(),
    ),
  }
}

/** A folded Info section's one-line summary: "62% 5 h · 80% week"; Antigravity names its model group first. */
export function quotaSummary(windows: CodingQuotaWindow[], group: string | null = null): string {
  const text = windows
    .map((window) => {
      const left = leftPercent(window)
      return left === null
        ? `${shortWindow(window)} ${missingText(window)}`
        : `${left}% ${shortWindow(window)}`
    })
    .join(' · ')
  return group ? `${group}: ${text}` : text
}
