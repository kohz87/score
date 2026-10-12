import { z } from 'zod'

// Coding-run journal records (7.7a design v7 §2 "Coding records" and §3 phases). Every record carries the launch's FULL
// state, not just its phase, so reconciliation compares everything (and so compaction can keep only the latest one).
// Plain data and pure functions: the journal (journal.ts) owns I/O, `coding-journal.ts` owns the critical sections.

export const CODING_PHASES = [
  'authorised',
  'requested',
  'armed',
  'releasing',
  'released',
  'ended',
  'settled',
] as const
export type CodingPhase = (typeof CODING_PHASES)[number]

/** The journal record kinds, in the order a launch normally meets them. `revoked` is the branch before `releasing`. */
export const CODING_RECORD_KINDS = [
  'launch-requested',
  'armed',
  'releasing',
  'revoked',
  'released-seen',
  'ended',
  'settled',
] as const
export type CodingRecordKind = (typeof CODING_RECORD_KINDS)[number]

const nonEmpty = z.string().min(1)
/** Identity of the launch: immutable once the first record exists. */
export const CodingIdentityShape = {
  launchId: nonEmpty,
  runId: nonEmpty,
  turnId: nonEmpty,
  generation: z.int().nonnegative(),
}
export const CodingStateShape = {
  ...CodingIdentityShape,
  phase: z.enum(CODING_PHASES),
  /** Once true, never false again; the launch must be stopped/reconciled, never treated as "never ran" (§3). */
  revoked: z.boolean(),
  /** "Release possibility": true from the `releasing` record on, monotonic. */
  mayHaveExecuted: z.boolean(),
  unit: nonEmpty.optional(),
  invocationId: nonEmpty.optional(),
  cgroup: nonEmpty.optional(),
  proof: z.string().optional(),
  disposition: z.string().optional(),
  waiver: z.boolean().optional(),
}
export type CodingState = z.infer<z.ZodObject<typeof CodingStateShape>>
export type CodingIdentity = Pick<CodingState, 'launchId' | 'runId' | 'turnId' | 'generation'>
/** What a transition may set besides identity and the monotonic flags. */
export type CodingPatch = Partial<
  Pick<CodingState, 'unit' | 'invocationId' | 'cgroup' | 'proof' | 'disposition' | 'waiver'>
>

/** A coding record's schema parts, to be spread under the journal's `Base` (n, at, scope). */
export function codingRecordSchemas<Base extends z.core.$ZodShape>(base: Base) {
  const record = (kind: CodingRecordKind) =>
    z.object({ ...base, kind: z.literal(kind), ...CodingStateShape })
  return [
    record('launch-requested'),
    record('armed'),
    record('releasing'),
    record('revoked'),
    record('released-seen'),
    record('ended'),
    record('settled'),
    // What compaction leaves of a launch: its newest record, kept forever (§2). `of` names the record it was.
    z.object({
      ...base,
      kind: z.literal('coding-tombstone'),
      of: z.enum(CODING_RECORD_KINDS),
      ...CodingStateShape,
    }),
  ] as const
}

/** The record kinds allowed after the given latest kind (undefined = the launch has no record yet). */
const NEXT: Record<CodingRecordKind | 'none', readonly CodingRecordKind[]> = {
  none: ['launch-requested', 'revoked'],
  'launch-requested': ['armed', 'revoked', 'ended'],
  armed: ['releasing', 'revoked', 'ended'],
  // No `revoked` here: once `releasing` won, revocation is a Stop of a possibly-executing run (§3).
  releasing: ['released-seen', 'ended'],
  'released-seen': ['ended'],
  ended: ['settled'],
  revoked: ['ended', 'settled'],
  settled: [],
}
export function transitionAllowed(
  from: CodingRecordKind | undefined,
  to: CodingRecordKind,
): boolean {
  return NEXT[from ?? 'none'].includes(to)
}

const PHASE_OF: Record<Exclude<CodingRecordKind, 'revoked'>, CodingPhase> = {
  'launch-requested': 'requested',
  armed: 'armed',
  releasing: 'releasing',
  'released-seen': 'released',
  ended: 'ended',
  settled: 'settled',
}

/** The state after `kind`: identity and the two monotonic flags can only grow; everything else is the patch. */
export function nextState(
  previous: CodingState | undefined,
  identity: CodingIdentity,
  kind: CodingRecordKind,
  patch: CodingPatch,
): CodingState {
  const base: CodingState = previous ?? {
    ...identity,
    phase: 'authorised',
    revoked: false,
    mayHaveExecuted: false,
  }
  return {
    ...base,
    ...patch,
    ...identity,
    phase: kind === 'revoked' ? base.phase : PHASE_OF[kind],
    revoked: base.revoked || kind === 'revoked',
    mayHaveExecuted: base.mayHaveExecuted || kind === 'releasing',
  }
}

export function sameIdentity(a: CodingIdentity, b: CodingIdentity): boolean {
  return (
    a.launchId === b.launchId &&
    a.runId === b.runId &&
    a.turnId === b.turnId &&
    a.generation === b.generation
  )
}

export function stateOf(record: CodingState): CodingState {
  const state = {
    launchId: record.launchId,
    runId: record.runId,
    turnId: record.turnId,
    generation: record.generation,
    phase: record.phase,
    revoked: record.revoked,
    mayHaveExecuted: record.mayHaveExecuted,
    ...(record.unit === undefined ? {} : { unit: record.unit }),
    ...(record.invocationId === undefined ? {} : { invocationId: record.invocationId }),
    ...(record.cgroup === undefined ? {} : { cgroup: record.cgroup }),
    ...(record.proof === undefined ? {} : { proof: record.proof }),
    ...(record.disposition === undefined ? {} : { disposition: record.disposition }),
    ...(record.waiver === undefined ? {} : { waiver: record.waiver }),
  }
  return state
}

/** A launch's latest word in a journal: its state, the record kind and the journal number. */
export interface CodingLaunch {
  state: CodingState
  kind: CodingRecordKind
  n: number
  /** Set when the journal's own sequence for this launch broke the rules (tampering or a bug): reconcile by hand. */
  violation?: string
}

interface AnyCodingEntry extends CodingState {
  kind: string
  of?: CodingRecordKind
  n: number
}

/** Folds journal entries into each launch's latest state, checking every step against the transition table. */
export function foldCodingLaunches(
  entries: readonly { kind: string; n: number }[],
): Map<string, CodingLaunch> {
  const launches = new Map<string, CodingLaunch>()
  for (const raw of entries) {
    const entry = raw as AnyCodingEntry
    const isTombstone = entry.kind === 'coding-tombstone'
    if (!isTombstone && !(CODING_RECORD_KINDS as readonly string[]).includes(entry.kind)) continue
    const kind = isTombstone ? entry.of! : (entry.kind as CodingRecordKind)
    const previous = launches.get(entry.launchId)
    let violation = previous?.violation
    // Compaction folds older records away, so a launch's first surviving record may be any kind; only steps between
    // surviving records are checked. A tombstone is the folded newest record: it may repeat the kind it replaced.
    if (
      previous &&
      !(isTombstone && kind === previous.kind) &&
      !transitionAllowed(previous.kind, kind)
    )
      violation ??= `${previous.kind} → ${kind} is not a legal transition`
    if (previous && !sameIdentity(previous.state, entry))
      violation ??= 'the launch identity changed'
    if (previous?.state.mayHaveExecuted && !entry.mayHaveExecuted)
      violation ??= 'release possibility was cleared'
    if (previous?.state.revoked && !entry.revoked) violation ??= 'revocation was cleared'
    launches.set(entry.launchId, {
      state: stateOf(entry),
      kind,
      n: entry.n,
      ...(violation === undefined ? {} : { violation }),
    })
  }
  return launches
}

/** Highest journal number of any coding record (the checkpoint the database must have reached). */
export function maxCodingN(entries: readonly { kind: string; n: number }[]): number {
  let max = 0
  for (const entry of entries)
    if (
      entry.kind === 'coding-tombstone' ||
      (CODING_RECORD_KINDS as readonly string[]).includes(entry.kind)
    )
      max = Math.max(max, entry.n)
  return max
}
