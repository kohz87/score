import { createHash, randomBytes } from 'node:crypto'
import { XTC_CAPABILITY_PLACEHOLDER } from '@score/contract'

// The per-turn exchange capability (docs/briefs/11.0-bold.md §4.2), built like the orchestrator's `orc_`: only the
// hash is stored (on the turn's message_runs row, while the turn may act); the plaintext exists in memory while the
// payload to Hermes is built, and in the agent's Hermes session history. A generic intent replay after a crash sends
// the placeholder instead, so that turn's actions are refused and it ends as a plain reply.

export const mintXtc = (): string => `xtc_${randomBytes(32).toString('base64url')}`
export const hashXtc = (capability: string): string =>
  createHash('sha256').update(capability).digest('hex')

/** Anything shaped like a capability (ours or the orchestrator's): an action carrying one is refused, stored nowhere. */
const CAPABILITY_LIKE = /(?:xtc|orc)_[A-Za-z0-9_-]{8,}/
export function hasCapabilityText(value: unknown): boolean {
  if (typeof value === 'string') return CAPABILITY_LIKE.test(value)
  if (Array.isArray(value)) return value.some(hasCapabilityText)
  if (value !== null && typeof value === 'object')
    return Object.entries(value).some(
      ([key, child]) => CAPABILITY_LIKE.test(key) || hasCapabilityText(child),
    )
  return false
}

/** Inserts the capability into the outbound payload only; the stored input keeps the placeholder. */
export const withXtc = (stored: string, capability: string): string =>
  stored.replaceAll(XTC_CAPABILITY_PLACEHOLDER, () => capability)
