import { StreamEventSchema, type StreamEvent } from '@score/contract'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import type { ScoreDb } from '../db/index.ts'

export type DomainEventDraft = {
  [T in StreamEvent['type']]: { type: T; data: Extract<StreamEvent, { type: T }>['data'] }
}[StreamEvent['type']]

export interface ApplyContext {
  sqlite: DatabaseSync
  now: string
}

const CheckpointSchema = z.object({
  scope: z.string().min(1),
  position: z.int().nonnegative(),
  incarnation: z.string().nullable(),
  resetIncarnation: z.boolean().optional(),
})

export interface Observation {
  source: string
  identity: string
  checkpoint?: z.infer<typeof CheckpointSchema>
  apply(ctx: ApplyContext): DomainEventDraft[]
}

export type IngestResult = { status: 'applied'; seqs: number[] } | { status: 'duplicate' }
export type DeepReadonly<T> = T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T
export type CommittedListener = (events: DeepReadonly<StreamEvent[]>) => void | Promise<void>

export interface Ingest {
  submit(obs: Observation): Promise<IngestResult>
  onCommitted(listener: CommittedListener): () => void
  /** Wait for the writer queue only; async listener delivery is independent. */
  drain(): Promise<void>
  flushListeners(): Promise<void>
  close(): Promise<void>
  releaseHold(source: string, scope: string): void
  clearHolds(source: string, scope: string, throughPosition: number): void
  heldPositions(source: string, scope: string): number[]
}

const owners = new WeakMap<ScoreDb, Ingest>()
const FloorRowSchema = z.object({ floor: z.int().nonnegative() })
const EventSeqSchema = z.int().positive()
const CheckpointRowSchema = z.object({
  cursor: z.string().regex(/^\d+$/).transform(Number).pipe(z.int().nonnegative()),
  incarnation: z.string().nullable(),
})
const ObservationMetadataSchema = z.object({
  source: z.string().min(1),
  identity: z.string().min(1),
  checkpoint: CheckpointSchema.optional(),
})

function holdKey(source: string, scope: string): string {
  return JSON.stringify([source, scope])
}

export function heldIngestPositions(db: ScoreDb, source: string, scope: string): number[] {
  return owners.get(db)?.heldPositions(source, scope) ?? []
}

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value as DeepReadonly<T>
}

// Guard cached methods and prepared statements as well as later accesses to the connection.
function scopedConnection(sqlite: DatabaseSync): { sqlite: DatabaseSync; revoke(): void } {
  let active = true
  const revokers: (() => void)[] = []
  function wrap<T extends object>(target: T): T {
    const { proxy, revoke } = Proxy.revocable(target, {
      get(target, property) {
        const value: unknown = Reflect.get(target, property, target)
        if (typeof value !== 'function') return value
        return (...args: unknown[]) => {
          if (!active) throw new Error('Observation SQLite access has expired')
          const result: unknown = Reflect.apply(value, target, args)
          return (property === 'prepare' ||
            property === 'iterate' ||
            property === Symbol.iterator) &&
            result !== null &&
            typeof result === 'object'
            ? wrap(result)
            : result
        }
      },
    })
    revokers.push(revoke)
    return proxy
  }
  return {
    sqlite: wrap(sqlite),
    revoke() {
      active = false
      for (const revoke of revokers) revoke()
    },
  }
}

function logListenerError(error: unknown): void {
  console.error('Ingest committed listener failed', error)
}

// Derived events computed in the same transaction as an observation's own drafts (e.g. a task card whose
// "needs you" state follows an approval). Keeps this hub free of domain imports.
export type DeriveEvents = (
  sqlite: DatabaseSync,
  drafts: DomainEventDraft[],
  context: { source: string; now: string },
) => DomainEventDraft[]

export function createIngest(
  db: ScoreDb,
  { clock = Date.now, deriveEvents }: { clock?: () => number; deriveEvents?: DeriveEvents } = {},
): Ingest {
  if (owners.has(db)) throw new Error('This ScoreDb already has an open ingest')
  let tail: Promise<void> = Promise.resolve()
  let accepting = true
  let closing: Promise<void> | undefined
  const listeners = new Map<CommittedListener, { tail: Promise<void>; active: boolean }>()
  const pendingListeners = new Set<Promise<void>>()
  const holds = new Map<string, Set<number>>()

  function recordHold(obs: Pick<Observation, 'source' | 'checkpoint'>): void {
    if (!obs.checkpoint) return
    const key = holdKey(obs.source, obs.checkpoint.scope)
    const failed = holds.get(key) ?? new Set<number>()
    failed.add(obs.checkpoint.position)
    holds.set(key, failed)
  }

  function advanceCheckpoint(sqlite: DatabaseSync, obs: Observation, now: string): void {
    const checkpoint = obs.checkpoint
    if (!checkpoint) return
    const row = sqlite
      .prepare('SELECT cursor, incarnation FROM ingest_checkpoints WHERE source = ? AND scope = ?')
      .get(obs.source, checkpoint.scope)
    const stored = row === undefined ? undefined : CheckpointRowSchema.parse(row)
    if (stored && stored.incarnation !== checkpoint.incarnation && !checkpoint.resetIncarnation) {
      throw new Error('Checkpoint incarnation change requires resetIncarnation')
    }
    const failed = holds.get(holdKey(obs.source, checkpoint.scope))
    // Clearing the retry's hold happens after COMMIT; ignore it only for this advancement attempt.
    if (
      failed &&
      [...failed].some(
        (position) => position !== checkpoint.position && position <= checkpoint.position,
      )
    ) {
      return
    }
    if (stored?.incarnation === checkpoint.incarnation && checkpoint.position <= stored.cursor)
      return
    sqlite
      .prepare(
        `INSERT INTO ingest_checkpoints (source, scope, cursor, incarnation, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (source, scope) DO UPDATE SET
           cursor = excluded.cursor, incarnation = excluded.incarnation, updated_at = excluded.updated_at`,
      )
      .run(obs.source, checkpoint.scope, String(checkpoint.position), checkpoint.incarnation, now)
  }

  function ingest(obs: Observation): IngestResult {
    let revoke = () => {}
    try {
      const now = new Date(clock()).toISOString()
      const committed = db.tx((sqlite): { result: IngestResult; events: StreamEvent[] } => {
        const checkpoint = obs.checkpoint
        if (checkpoint) {
          const row = sqlite
            .prepare(
              'SELECT floor FROM ingest_floors WHERE source = ? AND scope = ? AND incarnation = ?',
            )
            .get(obs.source, checkpoint.scope, checkpoint.incarnation ?? '')
          if (row !== undefined && FloorRowSchema.parse(row).floor >= checkpoint.position) {
            advanceCheckpoint(sqlite, obs, now)
            return { result: { status: 'duplicate' }, events: [] }
          }
        }
        const inserted = sqlite
          .prepare(
            `INSERT INTO ingest_keys (source, identity, first_seq, created_at, scope, incarnation, position)
             VALUES (?, ?, NULL, ?, ?, ?, ?)
             ON CONFLICT (source, identity) DO NOTHING`,
          )
          .run(
            obs.source,
            obs.identity,
            now,
            checkpoint?.scope ?? null,
            checkpoint?.incarnation ?? null,
            checkpoint?.position ?? null,
          )
        if (inserted.changes === 0) {
          advanceCheckpoint(sqlite, obs, now)
          return { result: { status: 'duplicate' }, events: [] }
        }
        const kind = obs.apply.constructor.name
        if (kind === 'AsyncFunction' || kind === 'AsyncGeneratorFunction') {
          throw new Error('Observation apply callbacks must be synchronous')
        }
        const scope = scopedConnection(sqlite)
        revoke = scope.revoke
        const drafts: unknown = obs.apply({ sqlite: scope.sqlite, now })
        if (
          drafts !== null &&
          (typeof drafts === 'object' || typeof drafts === 'function') &&
          'then' in drafts &&
          typeof drafts.then === 'function'
        ) {
          void Promise.resolve(drafts).catch(() => undefined)
          throw new Error('Observation apply callbacks must be synchronous')
        }
        if (!Array.isArray(drafts))
          throw new Error('Observation apply must return an array of drafts')
        const events: StreamEvent[] = []
        const append = sqlite.prepare('INSERT INTO events (ts, type, data) VALUES (?, ?, ?)')
        const normalizedDrafts = (drafts as DomainEventDraft[]).map((draft) => {
          const event = StreamEventSchema.parse({
            seq: 1,
            ts: now,
            type: draft.type,
            data: draft.data,
          })
          return { type: event.type, data: event.data } as DomainEventDraft
        })
        const derived = deriveEvents?.(sqlite, normalizedDrafts, { source: obs.source, now }) ?? []
        for (const draft of [...normalizedDrafts, ...derived]) {
          // Normalize before storage so replay and live subscribers receive the same payload.
          const parsed = StreamEventSchema.parse({
            seq: 1,
            ts: now,
            type: draft.type,
            data: draft.data,
          })
          const { lastInsertRowid } = append.run(
            parsed.ts,
            parsed.type,
            JSON.stringify(parsed.data),
          )
          events.push({ ...parsed, seq: EventSeqSchema.parse(Number(lastInsertRowid)) })
        }
        sqlite
          .prepare('UPDATE ingest_keys SET first_seq = ? WHERE source = ? AND identity = ?')
          .run(events[0]?.seq ?? null, obs.source, obs.identity)
        advanceCheckpoint(sqlite, obs, now)
        return { result: { status: 'applied', seqs: events.map((event) => event.seq) }, events }
      })
      revoke()
      revoke = () => {}
      if (obs.checkpoint) {
        const key = holdKey(obs.source, obs.checkpoint.scope)
        const failed = holds.get(key)
        failed?.delete(obs.checkpoint.position)
        if (failed?.size === 0) holds.delete(key)
      }
      if (committed.events.length > 0) {
        const batch = deepFreeze(committed.events)
        for (const [listener, entry] of listeners) {
          const pending = entry.tail
            .then(() => {
              if (entry.active) return listener(batch)
            })
            .catch(logListenerError)
          entry.tail = pending
          pendingListeners.add(pending)
          void pending.then(() => pendingListeners.delete(pending))
        }
      }
      return committed.result
    } catch (error) {
      recordHold(obs)
      throw error
    } finally {
      revoke()
    }
  }

  const hub: Ingest = {
    submit(obs) {
      if (!accepting) return Promise.reject(new Error('Ingest is closed'))
      // Capture validated metadata before a producer can reuse or mutate its observation object.
      let captured: Observation
      try {
        const metadata = ObservationMetadataSchema.parse(obs)
        captured = { ...metadata, apply: obs.apply }
      } catch (error) {
        const checkpoint = CheckpointSchema.safeParse(obs.checkpoint)
        if (checkpoint.success && typeof obs.source === 'string') {
          recordHold({ source: obs.source, checkpoint: checkpoint.data })
        }
        return Promise.reject(error)
      }
      const result = tail.then(() => ingest(captured))
      tail = result.then(
        () => undefined,
        () => undefined,
      )
      return result
    },
    onCommitted(listener) {
      if (!accepting) throw new Error('Ingest is closed')
      const entry = listeners.get(listener) ?? { tail: Promise.resolve(), active: true }
      listeners.set(listener, entry)
      return () => {
        if (listeners.get(listener) === entry) {
          entry.active = false
          listeners.delete(listener)
        }
      }
    },
    async drain() {
      let pending: Promise<void>
      do {
        pending = tail
        await pending
      } while (tail !== pending)
    },
    async flushListeners() {
      while (pendingListeners.size > 0) await Promise.all([...pendingListeners])
    },
    close() {
      accepting = false
      closing ??= (async () => {
        await hub.drain()
        for (const entry of listeners.values()) entry.active = false
        listeners.clear()
        owners.delete(db)
      })()
      return closing
    },
    releaseHold(source, scope) {
      holds.delete(holdKey(source, scope))
    },
    clearHolds(source, scope, throughPosition) {
      const key = holdKey(source, scope)
      const failed = holds.get(key)
      for (const position of failed ?? []) {
        if (position <= throughPosition) failed?.delete(position)
      }
      if (failed?.size === 0) holds.delete(key)
    },
    heldPositions(source, scope) {
      return [...(holds.get(holdKey(source, scope)) ?? [])]
    },
  }
  owners.set(db, hub)
  return hub
}
