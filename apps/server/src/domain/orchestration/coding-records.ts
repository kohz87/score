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
  // FY2: a stop was requested (fsynced before any signal; an annotation, the launch's phase is unchanged) and a person
  // waived an unprovable launch (settles it permanently: nothing acts on it again).
  'stop-requested',
  'waived',
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
  /** Who waived the launch (set by the `waived` record). */
  waivedBy: nonEmpty.optional(),
  /** The first cause of a stop request; never replaced (first cause wins). */
  stopCause: nonEmpty.optional(),
  /** Copied from another installation's journal: evidence only, never acted on (stop, reset, recover, release). */
  inherited: z.boolean().optional(),
  /**
   * The orchestration attempt generation that owns the launch (7.7b M4). Written by the `launch-requested` record,
   * immutable afterwards, and kept by every later record, the projection row and the tombstone: the coding step limit
   * counts launches by it, never by database joins alone.
   */
  owner: z
    .object({ orchestrationId: nonEmpty, attemptId: nonEmpty, generation: z.int().nonnegative() })
    .optional(),
  /** Why a revoked launch was revoked (7.7b §6 typed cause); written by the `revoked` record, never replaced. */
  revokeCause: nonEmpty.optional(),
}
export type CodingState = z.infer<z.ZodObject<typeof CodingStateShape>>
export type CodingIdentity = Pick<CodingState, 'launchId' | 'runId' | 'turnId' | 'generation'>
/** What a transition may set besides identity and the monotonic flags. */
export type CodingPatch = Partial<
  Pick<
    CodingState,
    | 'unit'
    | 'invocationId'
    | 'cgroup'
    | 'proof'
    | 'disposition'
    | 'waiver'
    | 'waivedBy'
    | 'stopCause'
    | 'inherited'
    | 'owner'
    | 'revokeCause'
  >
>

/** Why a launch was stopped (a short code such as `user`, `deadline`, `ingest-failure`); the first one is kept. */
export type StopCause = string

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
    record('stop-requested'),
    record('waived'),
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
  'launch-requested': ['armed', 'revoked', 'ended', 'stop-requested', 'waived'],
  armed: ['releasing', 'revoked', 'ended', 'stop-requested', 'waived'],
  // No `revoked` here: once `releasing` won, revocation is a Stop of a possibly-executing run (§3).
  releasing: ['released-seen', 'ended', 'stop-requested', 'waived'],
  'released-seen': ['ended', 'stop-requested', 'waived'],
  ended: ['settled', 'stop-requested', 'waived'],
  revoked: ['ended', 'settled', 'stop-requested', 'waived'],
  // Terminal: a settled or waived launch takes no further record.
  settled: [],
  waived: [],
  // Never a phase of its own (see `isAnnotation`); listed for the table's totality.
  'stop-requested': [],
}

/** Records that change no phase: the launch's phase kind stays what it was. */
export const isAnnotation = (kind: CodingRecordKind): boolean => kind === 'stop-requested'
export function transitionAllowed(
  from: CodingRecordKind | undefined,
  to: CodingRecordKind,
): boolean {
  return NEXT[from ?? 'none'].includes(to)
}

const PHASE_OF: Record<Exclude<CodingRecordKind, 'revoked' | 'stop-requested'>, CodingPhase> = {
  'launch-requested': 'requested',
  armed: 'armed',
  releasing: 'releasing',
  'released-seen': 'released',
  ended: 'ended',
  settled: 'settled',
  waived: 'settled',
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
  const next: CodingState = {
    ...base,
    ...patch,
    ...identity,
    phase: kind === 'revoked' || kind === 'stop-requested' ? base.phase : PHASE_OF[kind],
    revoked: base.revoked || kind === 'revoked',
    mayHaveExecuted: base.mayHaveExecuted || kind === 'releasing',
  }
  // Sticky: the first stop cause wins and a record copied from another installation never becomes ours.
  const stopCause = base.stopCause ?? patch.stopCause
  if (stopCause !== undefined) next.stopCause = stopCause
  else delete next.stopCause
  if (base.inherited || patch.inherited) next.inherited = true
  else delete next.inherited
  // The owner is written once, by the first record; the revoke cause by the revocation. Neither can change later.
  const owner = base.owner ?? patch.owner
  if (owner !== undefined) next.owner = owner
  else delete next.owner
  const revokeCause = base.revokeCause ?? (kind === 'revoked' ? patch.revokeCause : undefined)
  if (revokeCause !== undefined) next.revokeCause = revokeCause
  else delete next.revokeCause
  if (kind === 'waived') {
    next.waiver = true
    next.disposition = 'waived'
  }
  for (const key of Object.keys(next) as (keyof CodingState)[])
    if (next[key] === undefined) delete next[key]
  return next
}

/** The phase kind a launch is in, recovered from its state (a compacted launch may start with an annotation). */
export function kindOfState(state: CodingState): CodingRecordKind {
  if (state.waiver && state.disposition === 'waived') return 'waived'
  if (state.phase === 'settled') return 'settled'
  if (state.phase === 'ended') return 'ended'
  if (state.revoked) return 'revoked'
  if (state.phase === 'releasing') return 'releasing'
  if (state.phase === 'released') return 'released-seen'
  if (state.phase === 'armed') return 'armed'
  return 'launch-requested'
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
    ...(record.waivedBy === undefined ? {} : { waivedBy: record.waivedBy }),
    ...(record.stopCause === undefined ? {} : { stopCause: record.stopCause }),
    ...(record.inherited === undefined ? {} : { inherited: record.inherited }),
    ...(record.owner === undefined ? {} : { owner: record.owner }),
    ...(record.revokeCause === undefined ? {} : { revokeCause: record.revokeCause }),
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

/** Folds one journal entry into the launches' newest states, checking the step against the transition table. */
export function foldCodingEntry(
  launches: Map<string, CodingLaunch>,
  raw: { kind: string; n: number },
): void {
  const entry = raw as AnyCodingEntry
  const isTombstone = entry.kind === 'coding-tombstone'
  if (!isTombstone && !(CODING_RECORD_KINDS as readonly string[]).includes(entry.kind)) return
  const recorded = isTombstone ? entry.of! : (entry.kind as CodingRecordKind)
  const previous = launches.get(entry.launchId)
  let violation = previous?.violation
  // An annotation changes no phase: the launch stays in the phase kind it was in (inferred from the state when a
  // compacted launch starts with one).
  const annotation = isAnnotation(recorded)
  const kind = annotation ? (previous?.kind ?? kindOfState(entry)) : recorded
  // Compaction folds older records away, so a launch's first surviving record may be any kind; only steps between
  // surviving records are checked. A tombstone is the folded newest record: it may repeat the kind it replaced.
  if (
    previous &&
    !annotation &&
    !(isTombstone && kind === previous.kind) &&
    !transitionAllowed(previous.kind, kind)
  )
    violation ??= `${previous.kind} → ${kind} is not a legal transition`
  if (previous && annotation && !transitionAllowed(previous.kind, recorded))
    violation ??= `${previous.kind} → ${recorded} is not a legal transition`
  if (previous && !sameIdentity(previous.state, entry)) violation ??= 'the launch identity changed'
  if (previous?.state.mayHaveExecuted && !entry.mayHaveExecuted)
    violation ??= 'release possibility was cleared'
  if (previous?.state.revoked && !entry.revoked) violation ??= 'revocation was cleared'
  if (previous?.state.owner && JSON.stringify(previous.state.owner) !== JSON.stringify(entry.owner))
    violation ??= 'the launch owner changed'
  launches.set(entry.launchId, {
    state: stateOf(entry),
    kind,
    n: entry.n,
    ...(violation === undefined ? {} : { violation }),
  })
}

/** Folds journal entries into each launch's latest state, checking every step against the transition table. */
export function foldCodingLaunches(
  entries: readonly { kind: string; n: number }[],
): Map<string, CodingLaunch> {
  const launches = new Map<string, CodingLaunch>()
  for (const raw of entries) foldCodingEntry(launches, raw)
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
