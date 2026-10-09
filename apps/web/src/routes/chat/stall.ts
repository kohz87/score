import type { Message } from '@score/contract'

/** A streaming reply with no sign of life for this long is probably waiting inside Hermes (rate limit, provider error). */
export const STALL_AFTER_MS = 60_000
/** The elapsed time is shown in steps of this size, so the line changes twice a minute, not every tick. */
export const STALL_STEP_MS = 30_000

/** Hermes's own text for a turn it gave up on; Score shows a plainer line in its place. */
const NOT_PROCESSED = /^\s*your request was not processed/i
export const MODEL_DIDNT_ANSWER =
  'The model didn’t answer (provider error or rate limit). Try again or switch model.'
export const isNotProcessedNotice = (text: string) => NOT_PROCESSED.test(text)

/** How long a streaming reply has been silent, or null when it is not streaming or has not been silent long enough. */
export function stalledFor(message: Message, now: number): number | null {
  if (!message.streaming || message.author.kind !== 'agent') return null
  const since = Date.parse(message.progressAt ?? message.createdAt)
  if (Number.isNaN(since)) return null
  const silent = now - since
  return silent >= STALL_AFTER_MS ? silent : null
}

export function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / STALL_STEP_MS) * (STALL_STEP_MS / 1000)
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  if (!minutes) return `${rest} s`
  return rest ? `${minutes} min ${rest} s` : `${minutes} min`
}
