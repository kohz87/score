import type { AgentDetail, ApprovalMode, Rule } from '@score/contract'
import { HttpError } from '../errors.ts'
import { KNOWN_PATTERN_KEYS } from './pattern-keys.ts'

// Hermes approval settings as Score uses them (docs/reviews/2026-10-08-2.18-design-lead.md). Exactly three
// Hermes config keys are ever written: command_allowlist, approvals.deny and approvals.mode.
export interface ApprovalConfig {
  mode: ApprovalMode
  /** `command_allowlist`: pattern keys that never ask (known and unknown, in Hermes's order). */
  allowlist: string[]
  /** `approvals.deny`: fnmatch globs that always block. */
  deny: string[]
}
export const APPROVAL_WRITE_KEYS = [
  'command_allowlist',
  'approvals.deny',
  'approvals.mode',
] as const
export type ApprovalWriteKey = (typeof APPROVAL_WRITE_KEYS)[number]

export const MAX_MERGE_ATTEMPTS = 3
const KNOWN = new Set(KNOWN_PATTERN_KEYS)
export const isKnownPatternKey = (key: string): boolean => KNOWN.has(key)

export const NEVER_PREFIX = 'never:'
export const neverId = (glob: string): string => `${NEVER_PREFIX}${glob}`

export function patternLabel(key: string): string {
  return key.charAt(0).toUpperCase() + key.slice(1)
}
export function goAheadRule(key: string): Rule {
  return { id: key, label: patternLabel(key), pattern: key, readOnly: !isKnownPatternKey(key) }
}
export function neverRule(glob: string): Rule {
  return { id: neverId(glob), label: glob, pattern: glob, readOnly: false }
}

const unique = (items: readonly string[]): string[] => [...new Set(items)]

/** The expected Hermes config of a profile: team baseline, minus the agent's own go-ahead removals, plus its extra Nevers. */
export interface Baseline {
  mode: ApprovalMode
  goAhead: string[]
  never: string[]
}
export interface AgentOverrides {
  /** Go-ahead keys this agent has taken back (stricter than the team). */
  withoutGoAhead: string[]
  /** Never globs only this agent has. */
  extraNever: string[]
}
export function expectedConfig(
  current: ApprovalConfig,
  baseline: Baseline,
  overrides: AgentOverrides,
  /** Never globs Score managed before this change (old baseline); the rest of `current.deny` is Hermes's own. */
  previousNever: readonly string[] = [],
): ApprovalConfig {
  const managed = new Set([...previousNever, ...overrides.extraNever])
  const removed = new Set(overrides.withoutGoAhead)
  return {
    mode: baseline.mode,
    // Keys Score does not know are Hermes's own; they stay exactly as they are.
    allowlist: unique([
      ...current.allowlist.filter((key) => !isKnownPatternKey(key)),
      ...baseline.goAhead.filter((key) => !removed.has(key)),
    ]),
    // Deny entries Score never managed are stricter than anything it would set: keep them.
    deny: unique([
      ...baseline.never,
      ...overrides.extraNever,
      ...current.deny.filter((glob) => !managed.has(glob)),
    ]),
  }
}
/** True when the profile allows or lacks something the expected config says otherwise (extra deny entries are fine). */
export function drifted(actual: ApprovalConfig, expected: ApprovalConfig): boolean {
  const known = (list: string[]) => new Set(list.filter(isKnownPatternKey))
  const a = known(actual.allowlist)
  const e = known(expected.allowlist)
  return (
    actual.mode !== expected.mode ||
    a.size !== e.size ||
    [...e].some((key) => !a.has(key)) ||
    expected.deny.some((glob) => !actual.deny.includes(glob))
  )
}

export function permissionsOf(config: ApprovalConfig | null): AgentDetail['permissions'] {
  if (!config) return []
  const allowed = new Set(config.allowlist)
  return [
    ...KNOWN_PATTERN_KEYS.filter((key) => allowed.has(key)).map((key) => ({
      id: key,
      label: patternLabel(key),
      level: 'allowed' as const,
      inherited: false,
    })),
    ...config.deny.map((glob) => ({
      id: neverId(glob),
      label: glob,
      level: 'never' as const,
      inherited: false,
    })),
  ]
}

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((item) => b.includes(item))

/**
 * What "verified" means after a write. The re-read may carry entries someone else added meanwhile (Hermes appends
 * to command_allowlist when anybody answers "always"); that is fine. It may not lack anything we wrote, still
 * hold anything we removed, or have lost an entry we meant to keep.
 */
export function verifies(before: ApprovalConfig, wrote: ApprovalConfig, after: ApprovalConfig) {
  const list = (was: string[], want: string[], got: string[]) =>
    want.every((item) => got.includes(item)) &&
    was.filter((item) => !want.includes(item)).every((item) => !got.includes(item))
  return (
    after.mode === wrote.mode &&
    list(before.allowlist, wrote.allowlist, after.allowlist) &&
    list(before.deny, wrote.deny, after.deny)
  )
}

export interface ApprovalIo {
  read(): Promise<ApprovalConfig>
  /** Writes only the keys that differ between `current` and `next`. */
  write(current: ApprovalConfig, next: ApprovalConfig): Promise<void>
}

/**
 * read → modify → write → re-read verify, retried at most MAX_MERGE_ATTEMPTS times against a concurrent
 * writer. `edit` is applied to whatever was just read, so a retry merges instead of overwriting.
 */
export async function updateApprovalConfig(
  io: ApprovalIo,
  edit: (current: ApprovalConfig) => ApprovalConfig,
): Promise<ApprovalConfig> {
  for (let attempt = 1; attempt <= MAX_MERGE_ATTEMPTS; attempt++) {
    const current = await io.read()
    const next = edit(current)
    const unchanged =
      next.mode === current.mode &&
      sameSet(next.allowlist, current.allowlist) &&
      sameSet(next.deny, current.deny)
    if (unchanged) return current
    await io.write(current, next)
    const after = await io.read()
    if (verifies(current, next, after)) return after
  }
  throw new HttpError(409, 'conflict', 'Hermes approval settings kept changing while saving')
}
