import { ORC_CAPABILITY_PATTERN, ORC_CAPABILITY_PLACEHOLDER } from '@score/contract'
import { createHash, randomBytes } from 'node:crypto'

// A per-turn bearer capability (design v2 "Authority"). Only the hash is stored; the plaintext exists in memory while
// the dispatch payload is built, and in the lead's Hermes session history (accepted, v3.1 amendment 2).

export const mintCapability = (): string => `orc_${randomBytes(32).toString('base64url')}`
export const hashCapability = (capability: string): string =>
  createHash('sha256').update(capability).digest('hex')
export const isCapability = (value: string): boolean => ORC_CAPABILITY_PATTERN.test(value)

/** Anything shaped like a capability prefix: step inputs and lead-written text containing it are refused. */
const CAPABILITY_LIKE = /(?<![A-Za-z0-9])orc_[A-Za-z0-9_-]{8,}/
export const containsCapability = (text: string): boolean => CAPABILITY_LIKE.test(text)

/** Inserts the capability into the outbound payload only. The stored input keeps the placeholder. */
export const withCapability = (stored: string, capability: string): string =>
  stored.replaceAll(ORC_CAPABILITY_PLACEHOLDER, () => capability)
