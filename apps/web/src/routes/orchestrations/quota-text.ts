import type { QuotaHoldView } from '@score/contract'
import { resetText } from '../team/QuotaMeters.tsx'

// Words for the quota guard (PLAN 8.6): what a held step says about its coding agent's limit.

/** "its 5-hour limit", "its weekly limit", "the Gemini Models 5-hour limit". */
export function limitPhrase(window: '5 hours' | 'week', group: string | null): string {
  const base = window === 'week' ? 'weekly limit' : '5-hour limit'
  return group ? `the ${group} ${base}` : `its ${base}`
}

const left = (value: number): string => `${Math.round(value)}%`

/** The short label on a held step: "Held: limit low (6% left, resets 3:40 pm)". */
export function heldCaption(
  hold: Pick<QuotaHoldView, 'leftPercent' | 'resetsAt' | 'state'>,
  now = new Date(),
): string {
  const resets = resetText(hold.resetsAt, now)
  if (hold.state === 'waiting')
    return `Waiting for the limit to reset${resets ? ` (${resets})` : ''}`
  if (hold.state === 'override') return 'Starting anyway: you chose to use it'
  return `Held: limit low (${left(hold.leftPercent)} left${resets ? `, resets ${resets}` : ''})`
}

/** The same as a sentence, for a step's detail line. */
export const heldLine = (
  hold: Pick<QuotaHoldView, 'leftPercent' | 'resetsAt' | 'state'>,
  now = new Date(),
): string => `${heldCaption(hold, now)}.`

/** The Needs you headline for a held step. */
export function heldNeedsText(what: string, agentId: string): string {
  return `${what} is held: ${agentId}’s limit is low`
}
