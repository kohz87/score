import { ApiError } from '../data/api.ts'

/** The one sentence every bold surface uses when this browser has not paired with the server. */
export const PAIR_BROWSER = 'Pair this browser first.'

/** The pairing problem behind a failed write, or null when the failure is something else. */
export function pairingProblem(error: unknown): string | null {
  return error instanceof ApiError &&
    (error.status === 401 || error.status === 403 || error.code === 'not_paired')
    ? PAIR_BROWSER
    : null
}
