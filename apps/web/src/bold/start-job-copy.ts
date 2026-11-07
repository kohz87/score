import { ApiError } from '../data/api.ts'
import { pairingProblem } from './bold-errors.ts'
import { describeCreateError } from '../routes/orchestrations/NewOrchestrationDialog.tsx'

/** What the box takes for anything but a lead job (the earlier limit, kept). */
export const WHAT_CHARS = 4000

export function sizeText(n: number, unit: 'KB' | 'characters'): string {
  return unit === 'KB' ? `${(n / 1024).toFixed(1)} KB` : `${n.toLocaleString()} characters`
}

export function startError(error: unknown): string {
  // Checked first: the server answers it with a 403, which pairingProblem would call "pair this browser".
  if (error instanceof ApiError && error.code === 'fresh_auth_required')
    return 'Confirm your password or passkey again, then start the job.'
  const pairing = pairingProblem(error)
  if (pairing) return pairing
  if (error instanceof ApiError) {
    if (error.code === 'conflict') return error.message
    // A coding agent changed, or its reach wasn't accepted: the plain words say what to look at and do.
    if (error.code === 'policy_changed' || error.code === 'reach_not_acknowledged')
      return describeCreateError(error)
    if (error.code === 'paused') return 'Work is paused. Resume the team or the agent first.'
    if (error.code === 'no_lead') return 'This team has no lead yet.'
    if (error.code === 'invalid_check' || error.code === 'second_factor_not_enrolled')
      return error.message
    if (error.code === 'fresh_auth_required')
      return 'Confirm your password or passkey again, then start the job.'
  }
  if (error instanceof Error && error.message) return error.message
  return describeCreateError(error)
}

export function authProblem(error: unknown): string {
  const code = error instanceof ApiError ? error.code : null
  if (code === 'wrong_password') return 'That is not the security password.'
  if (code === 'too_many_attempts') return 'Too many wrong passwords. Try again later.'
  if (code === 'password_not_set') return 'Set a security password in Settings first.'
  return 'Couldn’t confirm that. Try again.'
}
