import type { CodingQuota, CodingQuotaWindow } from '@score/contract'

// The quota guard's one rule (PLAN 8.6, decision 91): is a coding agent's latest reading below the floor?
// Missing, unknown or expired readings never count as below, so the guard can't block on data it doesn't have.

export interface BelowFloor {
  window: CodingQuotaWindow['name']
  group: string | null
  /** Whole percent still available in that window (0–100). */
  leftPercent: number
  /** When the window resets; always in the future (a window whose reset has passed counts as reset). */
  resetsAt: string
}

export const DEFAULT_QUOTA_FLOOR = 10
export const MAX_QUOTA_FLOOR = 50

/** Antigravity's `/usage` group names (1.4.0). */
const GEMINI_GROUP = 'Gemini Models'
const ARGON_GROUP = 'Gemini 4 Argon'
const CLAUDE_GPT_GROUP = 'Claude and GPT models'

/**
 * The `/usage` group an Antigravity model id draws on, or null when the id isn't known (then every group counts).
 * `gemini-4-argon-*` has its own weekly group, other `gemini-*` ids share "Gemini Models", `claude-*` and `gpt-*` ids
 * share "Claude and GPT models". "CLI default" (no model chosen) is a Gemini model, so it uses "Gemini Models".
 */
export function antigravityGroupOf(model: string | null | undefined): string | null {
  if (model === null || model === undefined || model.trim() === '') return GEMINI_GROUP
  const id = model.trim().toLowerCase()
  if (id.startsWith('gemini-4-argon')) return ARGON_GROUP
  if (id.startsWith('gemini-')) return GEMINI_GROUP
  if (id.startsWith('claude-') || id.startsWith('gpt-')) return CLAUDE_GPT_GROUP
  return null
}

/**
 * The window of the latest reading that is below `floor` percent left, or null. `floor` 0 is off. Only windows with a known
 * share and a reset time still ahead count; for Antigravity only the windows of the model's own group do (all groups
 * when the model's group is unknown). When several windows are low, the one with the least left is returned.
 */
export function belowFloor(
  quota: CodingQuota | null | undefined,
  floor: number,
  now: Date | number,
  model: string | null | undefined,
): BelowFloor | null {
  if (!quota || !(floor > 0)) return null
  const nowMs = typeof now === 'number' ? now : now.getTime()
  const group = quota.runtime === 'antigravity' ? antigravityGroupOf(model) : null
  let worst: BelowFloor | null = null
  for (const window of quota.windows) {
    if (group !== null && (window.group ?? '').toLowerCase() !== group.toLowerCase()) continue
    if (window.usedPercent === null || window.resetsAt === null) continue
    if (Date.parse(window.resetsAt) <= nowMs) continue
    const left = 100 - window.usedPercent
    if (left >= floor) continue
    if (worst === null || left < worst.leftPercent)
      worst = {
        window: window.name,
        group: window.group,
        leftPercent: Math.max(0, Math.round(left * 10) / 10),
        resetsAt: window.resetsAt,
      }
  }
  return worst
}
