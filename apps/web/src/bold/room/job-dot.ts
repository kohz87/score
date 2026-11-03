import type { Job } from '@score/contract'

/** The colour of a topic's state dot (Info's Topics list, Search results). */
export function jobDot(state: Job['state']) {
  if (state === 'working') return 'var(--ok)'
  if (state === 'waiting_on_you') return 'var(--bad)'
  if (state === 'done') return 'var(--ok)'
  if (state === 'closed') return 'var(--faint)'
  return 'var(--muted)'
}
