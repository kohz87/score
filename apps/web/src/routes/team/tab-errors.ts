import { ApiError } from '../../data/api.ts'

/** One plain sentence for a failed tab action; Hermes limits (501) are explained, not retried. */
export function tabFailure(error: unknown, action: string): string {
  if (error instanceof ApiError) {
    if (error.code === 'not_paired')
      return `Pair this browser using the link in the server terminal to ${action}.`
    if (error.status === 501) return `Hermes does not support this yet: ${error.message}`
    // The server says why (an unset provider, a busy agent…): show that, and the generic line only when it said nothing.
    if (error.status === 409)
      return error.message.trim() || `Hermes rejected the change, so nothing was changed.`
  }
  return `Couldn’t ${action}. Try again.`
}
