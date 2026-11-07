import { ApiError } from '../../data/api.ts'
import { describeOrchError } from './orchestration-queries.ts'

export function describeCreateError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'preflight_failed') return 'Something it needs is missing:'
    if (error.code === 'capacity')
      return 'Score is already running as many orchestrations or steps as it allows. Try again when one has finished.'
    if (error.code === 'quota_exhausted') return 'There isn’t enough storage left for another run.'
    if (error.code === 'fenced') return 'Starting work is blocked until you review the list on Now.'
    if (error.code === 'policy_changed')
      return 'A coding agent changed since you looked. Check what it can read below, then start again.'
    if (error.code === 'reach_not_acknowledged')
      return 'Accept what the coding agents can read before you start.'
    if (error.code === 'coding_workers_need_units')
      return 'Coding agents can take steps only where Score runs them as system services, and this computer isn’t set up for that.'
  }
  return describeOrchError(error)
}
