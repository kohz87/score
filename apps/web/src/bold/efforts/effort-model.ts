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

/** What the agent's own setting reads as, in words; null (the model's default) reads as "the model's default". */
export const ownEffortLabel = (own: string | null) => own ?? 'the model’s default'

/** The context bar's and the tags' button text. */
export const effortButtonLabel = (level: string) => `Effort ${level}`
