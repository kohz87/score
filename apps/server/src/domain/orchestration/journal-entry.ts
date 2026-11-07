import { z } from 'zod'
import { codingRecordSchemas } from './coding-records.ts'

const Base = { n: z.int().positive(), at: z.iso.datetime(), scope: z.string().min(1) }
export const EntrySchema = z.discriminatedUnion('kind', [
  z.object({
    ...Base,
    kind: z.literal('send_started'),
    attemptId: z.string().min(1),
    orchestrationId: z.string().min(1),
    attemptKind: z.enum(['lead', 'step']),
    agentId: z.string().min(1),
    generation: z.int().nonnegative(),
    /** Coding workers (7.7b §5): the generation's own turn id and pre-minted launch id, so a restart can ask the coding journal whether it ever launched. */
    turnId: z.string().min(1).optional(),
    launchId: z.string().min(1).optional(),
  }),
  // 7.7b §6: generation `generation` is proven to have launched nothing (a revoke tombstone, or no launch was ever
  // requested), for a cause that is not a refusal. The attempt is sendable as the next generation or ends, per the cause
  // table; refusal counters are never touched.
  z.object({
    ...Base,
    kind: z.literal('send_closed'),
    attemptId: z.string().min(1),
    orchestrationId: z.string().min(1),
    generation: z.int().positive(),
    cause: z.string().min(1).max(64),
  }),
  // v8.2: a proven refusal (nothing reached Hermes) of dispatch generation `generation`. With the matching
  // `send_started` it says the attempt is unsent again; any later generation starts with a new `send_started`.
  z.object({
    ...Base,
    kind: z.literal('send_refused'),
    attemptId: z.string().min(1),
    orchestrationId: z.string().min(1),
    generation: z.int().positive(),
  }),
  // v8.3: what compaction leaves of an attempt's older generations. Latest generation + its state keep the restore
  // check able to see a database that is behind it; `refusedCount` is informational.
  z.object({
    ...Base,
    kind: z.literal('witness'),
    attemptId: z.string().min(1),
    orchestrationId: z.string().min(1),
    lastGeneration: z.int().positive(),
    lastState: z.enum(['refused', 'sent', 'closed']),
    refusedCount: z.int().nonnegative(),
  }),
  z.object({
    ...Base,
    kind: z.literal('run_handle'),
    attemptId: z.string().min(1),
    runId: z.string().min(1),
    /** Coding workers: the dispatch generation the handle belongs to. Only the latest admitted generation's handle is verified or attached. */
    generation: z.int().positive().optional(),
  }),
  z.object({
    ...Base,
    kind: z.literal('stop_fence'),
    orchestrationId: z.string().min(1),
    /** Set for a cancelled step: the fence is on that attempt, not on the whole run. */
    attemptId: z.string().min(1).optional(),
    reason: z.string(),
  }),
  z.object({
    ...Base,
    kind: z.literal('global_fence'),
    action: z.enum(['set', 'lift']),
    fenceSeq: z.int().nonnegative(),
    reason: z.string(),
    /** Journal entries (`n`) the person accepted as reconciled when lifting. */
    accepted: z.array(z.int().positive()).optional(),
  }),
  z.object({ ...Base, kind: z.literal('reconciled'), attemptId: z.string().min(1) }),
  // Every transition whose rollback would restore admission authority (design v3.2).
  z.object({
    ...Base,
    kind: z.literal('transition'),
    orchestrationId: z.string().min(1),
    what: z.enum(['finish', 'pause', 'resume', 'waiver', 'abandon', 'retry', 'try_again']),
    attemptIds: z.array(z.string().min(1)).optional(),
    /** Workflow decisions (retry, try_again) name their node. */
    nodeId: z.string().min(1).optional(),
  }),
  // The person's limits after every change (fix-h item 2): a database that is less restrictive than the newest one lost
  // a lowered budget, a shorter deadline or a revoked acceptance. The values are the full state, not the delta.
  z.object({
    ...Base,
    kind: z.literal('authorization'),
    orchestrationId: z.string().min(1),
    budgetUsd: z.number().nullable(),
    deadlineAt: z.string().nullable(),
    acceptUnknownSpend: z.boolean(),
    /** 7.7b: the coding step limit and the sources whose unknown cost was accepted (absent in older entries). */
    codingSteps: z.int().positive().optional(),
    acceptUnknownCost: z.array(z.string()).optional(),
  }),
  // The person's decision to use a replacement agent for the rest of the run (fix-h item 3).
  z.object({
    ...Base,
    kind: z.literal('remap'),
    orchestrationId: z.string().min(1),
    agentId: z.string().min(1),
    incarnation: z.string().min(1),
  }),
  // 7.7b §12a: "Use the new settings" for a coding step blocked `agent_changed`: the step's worker takes its current policy.
  z.object({
    ...Base,
    kind: z.literal('policy_remap'),
    orchestrationId: z.string().min(1),
    stepId: z.string().min(1),
    agentId: z.string().min(1),
    policyId: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  // 7.7c F1 #5: a coding node's dispatch renewal. The count and both attempt ids are the record: a database restored from
  // before it would give the node a renewal back, or still hold the predecessor as the step's attempt.
  z.object({
    ...Base,
    kind: z.literal('renewal'),
    orchestrationId: z.string().min(1),
    nodeId: z.string().min(1),
    /** The node's renewal count after this one. */
    renewals: z.int().positive(),
    predecessorId: z.string().min(1),
    successorId: z.string().min(1),
  }),
  // Team and agent pause holds live outside the orchestration tables but gate its admissions.
  z.object({
    ...Base,
    kind: z.literal('hold'),
    target: z.enum(['team', 'agent']),
    agentId: z.string().min(1).optional(),
    action: z.enum(['set', 'lift']),
  }),
  // What compaction leaves of an admission or a fence: permanent, tiny, enough to prove an older database is older.
  z.object({
    ...Base,
    kind: z.literal('tombstone'),
    of: z.enum(['send_started', 'stop_fence', 'transition', 'witness']),
    orchestrationId: z.string().min(1),
    attemptId: z.string().min(1).optional(),
    /** For a send: the latest generation and whether it was sent (always `sent` for a tombstone made from a send). */
    generation: z.int().nonnegative().optional(),
    /** For a tombstone of a `witness` (or of a compacted `send_refused`/`send_closed`): the last generation's state. */
    lastState: z.enum(['refused', 'sent', 'closed']).optional(),
    what: z
      .enum(['finish', 'pause', 'resume', 'waiver', 'abandon', 'retry', 'try_again'])
      .optional(),
    attemptIds: z.array(z.string().min(1)).optional(),
  }),
  // Keeps the sequence monotonic when compaction removed the newest entries.
  z.object({ ...Base, kind: z.literal('checkpoint') }),
  // 7.7a §2: written to the LEGACY path-scoped journal once this home's records were copied to its installation
  // namespace. After it, every writer refuses the legacy path for this home; the file stays as a read-only witness.
  z.object({
    ...Base,
    kind: z.literal('cutover'),
    installationId: z.string().min(1),
    /** The namespace directory name under the journal root (the installation id). */
    namespace: z.string().min(1),
    /** Highest legacy `n` of this home that was copied; anything of this home above it was written after the cutover. */
    copiedThrough: z.int().nonnegative(),
  }),
  // FV (decision 71) / FU (decision 72): `scripts/score installation reset-history` starts a fresh journal with this
  // record. The person decided to start a new history; the archived journal and launch folders are evidence only. The
  // random `generation` is stored in the database in the same step; a reset is finished only by the matching
  // `history-reset-complete` record, written after the database commit was made durable. Permanent.
  z.object({
    ...Base,
    kind: z.literal('history-reset'),
    /** Where the previous journal and launch folders were moved (a folder beside this journal). */
    archive: z.string().min(1),
    /** How many records the archived journal held (0 when it was missing). */
    archived: z.int().nonnegative(),
    /** Names this history; the database must carry the same one (a restored older database does not). */
    generation: z.string().min(1).max(100),
  }),
  z.object({
    ...Base,
    kind: z.literal('history-reset-complete'),
    generation: z.string().min(1).max(100),
  }),
  // FU (decision 72): why Score holds all agent work. Durable outside the database, so a restored older database can't
  // forget it; only a completed reset of a LATER generation supersedes it. Permanent.
  z.object({
    ...Base,
    kind: z.literal('execution-freeze'),
    reason: z.string().min(1).max(1000),
  }),
  // 7.7a §2/§3: coding-run records (launch-requested … settled) and their permanent tombstones.
  ...codingRecordSchemas(Base),
])
export type JournalEntry = z.infer<typeof EntrySchema>

type DistributiveOmit<T, K extends string> = T extends unknown ? Omit<T, K> : never
export type JournalEntryBody = DistributiveOmit<JournalEntry, 'n' | 'at' | 'scope'>
