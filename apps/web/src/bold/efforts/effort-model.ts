/**
 * Words for the effort per chat (decision 178). The descriptions for `low`, `high` and `max` are the mock-up's
 * (docs/design/bold/mockups/25-effort-*); `medium` and `xhigh` have none there, so theirs are the lead's.
 */
export const EFFORT_HINTS: Record<string, string> = {
  low: 'Quick answers',
  medium: 'Balanced',
  high: 'Thinks longer',
  xhigh: 'Thinks much longer',
  max: 'Thinks longest, costs most',
}

/** The level that gets the amber style (mock-up): the costliest one. */
export const isAmberEffort = (level: string | null) => level === 'max'

/**
 * What the agent's own setting reads as, in words. null is the model's default; undefined means the read did not answer
 * (it failed, the server's 503, or has not come back yet), which reads "unknown" rather than a default that may be wrong.
 */
export const ownEffortLabel = (own: string | null | undefined) =>
  own === undefined ? 'unknown' : (own ?? 'the model’s default')

/** The menu's note when the agent's levels could not be read: the choices that still work are named. */
export const unlistedLevelsNote = (name: string) =>
  `Can’t list the levels ${name}’s model takes right now. Back to its own still works.`

/** The context bar's and the tags' button text. */
export const effortButtonLabel = (level: string) => `Effort ${level}`
