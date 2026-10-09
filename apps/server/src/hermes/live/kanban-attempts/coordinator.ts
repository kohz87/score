import { createHash, randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import type { ScoreDb } from '../../../db/index.ts'
import type { ObservationSink } from '../../port.ts'
import { closeReadOnly, HermesDbMissing, incarnationOf, openReadOnly } from '../sqlite.ts'
import { associationPass } from './association.ts'
import { resolveUpgradeLinks, snapshotUpgradeLinks } from './upgrade.ts'
import { effectiveMark } from './history-policy.ts'
import { readCapture, readMarks, type ReaderHooks } from './reader.ts'
import {
  ATTEMPT_PAGE,
  EVENT_PAGE,
  FULLPASS_EVERY_MS,
  SAMPLE_SIZE,
  SWEEP_EVERY_MS,
  UNREADABLE_AFTER,
  type Capture,
} from './types.ts'
import {
  ensureSource,
  liveHistory,
  openHistory,
  pauseHistory,
  applyCapture,
  type ApplyResult,
  type HistoryRow,
  type WriterFaults,
} from './writer.ts'

export interface CoordinatorOptions {
  db: ScoreDb
  sink: ObservationSink
  /** Resolved path of the Kanban database. */
  path: string
  board?: string
  clock?: () => number
  unreadableAfter?: number
  /** Called after a capture committed (test seam for "crash after commit"). */
  afterCommit?: (capture: Capture, result: ApplyResult | undefined) => void
  reader?: ReaderHooks
  faults?: WriterFaults
  maxTailPages?: number
  maxBaselinePages?: number
  associationHooks?: { afterEdge?: () => void }
}

/** A failure to read Hermes (as opposed to writing Score's own database). */
class SourceReadError extends Error {
  constructor(cause: unknown) {
    super('Kanban source unreadable', { cause })
    this.name = 'SourceReadError'
  }
}

function reading<T>(fn: () => T): T {
  try {
    return fn()
  } catch (error) {
    throw new SourceReadError(error)
  }
}

export function sourceIdFor(path: string, board: string): string {
  let resolved = path
  try {
    resolved = realpathSync(path)
  } catch {
    // A missing file keeps its configured path; it gets a source row once it exists.
  }
  return `ks_${createHash('sha256').update(`${resolved}\0${board}`).digest('hex').slice(0, 16)}`
}

/**
 * One coordinator per source: it serializes baseline, tail, sweep and full-pass reads (one in flight) so an older
 * snapshot never overwrites a newer one. Each read is one capture with its own id; a retry after a failed write
 * resubmits the same captured page. In-memory progress advances only after the page committed.
 */
export class KanbanAttemptsCoordinator {
  readonly sourceId: string
  private readonly board: string
  private readonly clock: () => number
  private connection: { db: DatabaseSync; identity: string } | undefined
  private flight: Promise<void> | undefined
  private pending: Capture | undefined
  private lastSweep = 0
  private lastFullpass = 0
  private failures = 0
  private closed = false

  constructor(private readonly options: CoordinatorOptions) {
    this.board = options.board ?? 'default'
    this.sourceId = sourceIdFor(options.path, this.board)
    this.clock = options.clock ?? Date.now
  }

  poll(): Promise<void> {
    this.flight ??= this.pollOnce().finally(() => {
      this.flight = undefined
    })
    return this.flight
  }

  async close(): Promise<void> {
    this.closed = true
    await this.flight
    if (this.connection) closeReadOnly(this.connection.db)
    this.connection = undefined
  }

  private connect(): { db: DatabaseSync; identity: string } {
    const identity = incarnationOf(this.options.path)
    if (this.connection && this.connection.identity !== identity) {
      closeReadOnly(this.connection.db)
      this.connection = undefined
    }
    if (!this.connection) {
      const db = openReadOnly(this.options.path)
      let after: string
      try {
        after = incarnationOf(this.options.path)
      } catch (error) {
        closeReadOnly(db)
        throw error
      }
      // The path was swapped between stat and open: label the connection with what it really is next poll.
      if (after !== identity) {
        closeReadOnly(db)
        throw new Error('Kanban database changed while opening')
      }
      this.connection = { db, identity }
    }
    return this.connection
  }

  private history(): HistoryRow | undefined {
    return liveHistory(this.options.db.sqlite, this.sourceId)
  }

  private async pollOnce(): Promise<void> {
    if (this.closed) return
    // Before anything can rewrite the task projections, keep what the legacy links were proven by.
    await snapshotUpgradeLinks(this.options.db, this.options.sink, `kanban-attempts:${this.sourceId}`)
    let conn: { db: DatabaseSync; identity: string }
    try {
      conn = this.connect()
    } catch (error) {
      await this.unreadable(error)
      return
    }
    try {
      await this.step(conn)
      this.failures = 0
    } catch (error) {
      if (error instanceof SourceReadError) {
        await this.unreadable(error.cause)
        return
      }
      throw error
    }
  }

  /** The source cannot be read: after a few consecutive failures observation of its open attempts ends. */
  private async unreadable(error: unknown): Promise<void> {
    this.failures++
    if (this.connection) {
      closeReadOnly(this.connection.db)
      this.connection = undefined
    }
    const history = this.history()
    if (history && history.state === 'active' && this.failures >= (this.options.unreadableAfter ?? UNREADABLE_AFTER)) {
      const reason = error instanceof HermesDbMissing ? 'database missing' : 'database unreadable'
      await this.options.sink.submit({
        source: `kanban-attempts:${this.sourceId}`,
        identity: `kanban:pause:${randomUUID()}`,
        apply: ({ sqlite, now }) => {
          pauseHistory(sqlite, history.id, reason, now)
          return []
        },
      })
    }
  }

  private async step(conn: { db: DatabaseSync; identity: string }): Promise<void> {
    if (this.pending) {
      await this.submit(this.pending)
      return
    }
    if (!this.history()) await this.openFirstHistory(conn)
    for (let page = 0; page < (this.options.maxTailPages ?? 4); page++) {
      const history = this.history()
      if (!history) return
      const capture = this.read(conn, history, { kind: 'tail' })
      if (!this.isQuiet(history, capture)) await this.submit(capture)
      if (capture.events.length < EVENT_PAGE) break
    }
    for (let page = 0; page < (this.options.maxBaselinePages ?? 3); page++) {
      const history = this.history()
      if (!history || history.state !== 'active' || history.baseline_done) break
      await this.submit(this.read(conn, history, { kind: 'baseline', afterAttemptId: history.baseline_cursor }))
      if (page === (this.options.maxBaselinePages ?? 3) - 1) return
    }
    const history = this.history()
    if (!history || history.state !== 'active' || !history.baseline_done) return
    const now = this.clock()
    if (now - this.lastSweep >= SWEEP_EVERY_MS) {
      this.lastSweep = now
      const openIds = z
        .array(z.object({ attempt_id: z.int() }))
        .parse(
          this.options.db.sqlite
            .prepare(
              `SELECT attempt_id FROM kanban_attempts
                WHERE history_id = ? AND ended_at IS NULL AND deleted_upstream_at IS NULL
                ORDER BY attempt_id LIMIT 1000`,
            )
            .all(history.id),
        )
        .map((row) => row.attempt_id)
      if (openIds.length) await this.submit(this.read(conn, history, { kind: 'sweep', openIds }))
    }
    const latest = this.history()
    if (latest?.state === 'active' && now - this.lastFullpass >= FULLPASS_EVERY_MS) {
      this.lastFullpass = now
      await this.submit(this.read(conn, latest, { kind: 'fullpass', afterAttemptId: latest.fullpass_cursor }))
    }
    await this.afterBaseline(conn)
  }

  /** Legacy link upgrade and the late review-edge backfill need a verified, baselined history. */
  private async afterBaseline(conn: { db: DatabaseSync; identity: string }): Promise<void> {
    const history = this.history()
    if (!history || history.state !== 'active' || !history.baseline_done) return
    const source = `kanban-attempts:${this.sourceId}`
    await resolveUpgradeLinks(this.options.db, this.options.sink, source, history.id)
    await associationPass(
      this.options.db,
      this.options.sink,
      conn.db,
      { id: history.id, sourceId: this.sourceId, fileIdentity: conn.identity },
      this.options.associationHooks,
    )
  }

  private read(
    conn: { db: DatabaseSync; identity: string },
    history: HistoryRow,
    extra: { kind: Capture['kind']; afterAttemptId?: number; openIds?: number[] },
  ): Capture {
    return reading(() => readCapture(conn.db, this.request(conn, history, extra), this.options.reader))
  }

  private request(
    conn: { identity: string },
    history: HistoryRow,
    extra: {
      kind: Capture['kind']
      afterAttemptId?: number
      openIds?: number[]
    },
  ) {
    const identityChanged = history.file_identity !== null && history.file_identity !== conn.identity
    return {
      historyId: history.id,
      sourceId: this.sourceId,
      fileIdentity: conn.identity,
      afterEventId: history.event_cursor,
      eventLimit: EVENT_PAGE,
      attemptLimit: ATTEMPT_PAGE,
      // Up to 50 known attempts check a changed file identity (a copy onto a new inode keeps the history).
      ...(identityChanged ? { sampleIds: this.sampleIds(history) } : {}),
      ...extra,
    }
  }

  private sampleIds(history: HistoryRow): number[] {
    return z
      .array(z.object({ attempt_id: z.int() }))
      .parse(
        this.options.db.sqlite
          .prepare(
            `SELECT attempt_id FROM kanban_attempts
              WHERE history_id = ? AND deleted_upstream_at IS NULL ORDER BY attempt_id DESC LIMIT ?`,
          )
          .all(history.id, SAMPLE_SIZE),
      )
      .map((row) => row.attempt_id)
  }

  /** An eventless tail that confirms the saved marks and identity needs no page row. */
  private isQuiet(history: HistoryRow, capture: Capture): boolean {
    if (history.state !== 'active' || !capture.marks) return false
    if (capture.events.length || capture.attempts.length || capture.malformed) return false
    if (capture.eventScanned !== null) return false
    if (history.file_identity !== capture.fileIdentity) return false
    const events = effectiveMark('task_events', capture.marks.eventSeq, capture.marks.eventMin, capture.marks.eventMax)
    const runs = effectiveMark('task_runs', capture.marks.runSeq, capture.marks.runMin, capture.marks.runMax)
    return (
      'mark' in events &&
      'mark' in runs &&
      events.mark === history.event_alloc_mark &&
      runs.mark === history.attempt_alloc_mark
    )
  }

  private async openFirstHistory(conn: { db: DatabaseSync; identity: string }): Promise<void> {
    const marks = reading(() => readMarks(conn.db))
    if (!marks) throw new SourceReadError(new Error('Kanban sequence table unreadable'))
    const source = { id: this.sourceId, path: this.options.path, board: this.board }
    await this.options.sink.submit({
      source: `kanban-attempts:${this.sourceId}`,
      identity: `kanban:open:${randomUUID()}`,
      apply: ({ sqlite, now }) => {
        ensureSource(sqlite, source, now)
        if (liveHistory(sqlite, this.sourceId)) return []
        openHistory(sqlite, { sourceId: this.sourceId, marks, fileIdentity: conn.identity, now })
        return []
      },
    })
  }

  private async submit(capture: Capture): Promise<void> {
    this.pending = capture
    let result: ApplyResult | undefined
    try {
      await this.options.sink.submit({
        source: `kanban-attempts:${this.sourceId}`,
        identity: `kanban:${capture.kind}:${capture.captureId}`,
        // Only tail pages are event observations; baseline, sweep and full-pass pages carry no retirement floor.
        ...(capture.kind === 'tail' && capture.eventScanned !== null
          ? {
              checkpoint: {
                scope: 'tail',
                position: capture.eventScanned,
                incarnation: capture.historyId,
                resetIncarnation: true,
              },
            }
          : {}),
        apply: ({ sqlite, now }) => {
          result = applyCapture(sqlite, capture, now, this.options.faults)
          return []
        },
      })
    } finally {
      // (the capture stays pending when the write failed)
    }
    // Cleared only after the commit: a failed write replays the same capture id.
    this.pending = undefined
    this.options.afterCommit?.(capture, result)
  }
}
