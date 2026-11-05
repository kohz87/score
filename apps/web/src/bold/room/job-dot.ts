import type { Job } from '@score/contract'

/**
 * The colour of a job's state dot (Info, the job bar, Search). Red only when a decision waits (3.30.1): a job whose
 * agents are done and wait for the person's next message is calm, not an alarm.
 */
export function jobDot(state: Job['state'], needsYou = false) {
  if (needsYou) return 'var(--bad)'
  if (state === 'working') return 'var(--ok)'
  if (state === 'waiting_on_you') return 'var(--muted)'
  if (state === 'done') return 'var(--ok)'
  if (state === 'closed') return 'var(--faint)'
  return 'var(--muted)'
}
