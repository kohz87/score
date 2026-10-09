import { randomUUID } from 'node:crypto'
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { z } from 'zod'
import {
  ATTEMPT_PAGE,
  EVENT_PAGE,
  EVIDENCE_EVENT_LIMIT,
  HermesAttemptSchema,
  HermesEvidenceEventSchema,
  HermesTaskRowSchema,
  type Capture,
  type CaptureKind,
  type HermesAttempt,
  type HermesEvidenceEvent,
  type HermesTaskRow,
  type Marks,
} from './types.ts'

export interface CaptureRequest {
  kind: CaptureKind
  historyId: string
  sourceId: string
  fileIdentity: string
  /** tail: events after this id. */
  afterEventId?: number
  eventLimit?: number
  /** baseline/fullpass: attempts after this id, by primary key. */
  afterAttemptId?: number
  attemptLimit?: number
  /** sweep: Score's known open attempt ids. */
  openIds?: number[]
  /** Identity verification: up to 50 attempts Score already knows. */
  sampleIds?: number[]
}

export interface ReaderHooks {
  /** Test seam: runs between two queries of the same capture (proves the single read snapshot). */
  between?: (stage: string) => void
  now?: () => Date
}

const COLUMNS =
  'id, task_id, profile, status, claim_lock, worker_pid, worker_started_at, started_at, ended_at, outcome, summary, error'
const EVENT_COLUMNS =
  "id, task_id, run_id, kind, CASE WHEN kind = 'claimed' THEN payload END AS payload, created_at"

/** The kinds that carry positive evidence of a claim or of a started worker. */
export const EVIDENCE_KINDS = ['created', 'claimed', 'spawned', 'worker_registered'] as const

const IN_BATCH = 200

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ')
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let offset = 0; offset < values.length; offset += size)
    out.push(values.slice(offset, offset + size))
  return out
}

export function readMarks(db: DatabaseSync): Marks | null {
  try {
    const rows = z
      .array(z.object({ name: z.string(), seq: z.int().nonnegative() }))
      .parse(
        db
          .prepare("SELECT name, seq FROM sqlite_sequence WHERE name IN ('task_events', 'task_runs')")
          .all(),
      )
    const seq = new Map(rows.map((row) => [row.name, row.seq]))
    const probe = (table: 'task_events' | 'task_runs') => {
      const row = z
        .object({ lo: z.int().nullable(), hi: z.int().nullable() })
        .parse(db.prepare(`SELECT MIN(id) AS lo, MAX(id) AS hi FROM ${table}`).get())
      return row
    }
    const events = probe('task_events')
    const runs = probe('task_runs')
    return {
      eventSeq: seq.get('task_events') ?? null,
      runSeq: seq.get('task_runs') ?? null,
      eventMin: events.lo,
      eventMax: events.hi,
      runMin: runs.lo,
      runMax: runs.hi,
    }
  } catch {
    return null
  }
}

function parseRows<S extends z.ZodType>(
  schema: S,
  raw: unknown[],
  counter: { malformed: number },
): z.output<S>[] {
  const out: z.output<S>[] = []
  for (const row of raw) {
    const parsed = schema.safeParse(row)
    if (parsed.success) out.push(parsed.data)
    else counter.malformed++
  }
  return out
}

function attemptsByIds(
  db: DatabaseSync,
  ids: readonly number[],
  counter: { malformed: number },
): HermesAttempt[] {
  const out: HermesAttempt[] = []
  for (const chunk of chunks([...new Set(ids)].sort((a, b) => a - b), IN_BATCH)) {
    const raw = db
      .prepare(
        `SELECT ${COLUMNS} FROM task_runs WHERE id IN (${placeholders(chunk.length)}) ORDER BY id`,
      )
      .all(...chunk)
    out.push(...parseRows(HermesAttemptSchema, raw, counter))
  }
  return out
}

function evidenceFor(
  db: DatabaseSync,
  attempts: readonly HermesAttempt[],
  counter: { malformed: number },
): { events: HermesEvidenceEvent[]; truncated: boolean } {
  const events: HermesEvidenceEvent[] = []
  let truncated = false
  for (const chunk of chunks(attempts, IN_BATCH)) {
    const taskIds = [...new Set(chunk.map((attempt) => attempt.task_id))]
    const runIds = chunk.map((attempt) => attempt.id)
    const kinds = EVIDENCE_KINDS as readonly string[]
    // task_id IN (…) walks idx_events_task; the other terms only filter its rows.
    const raw = db
      .prepare(
        `SELECT ${EVENT_COLUMNS} FROM task_events
         WHERE task_id IN (${placeholders(taskIds.length)})
           AND (kind IN (${placeholders(kinds.length)}) OR run_id IN (${placeholders(runIds.length)}))
         ORDER BY id LIMIT ?`,
      )
      .all(...taskIds, ...kinds, ...runIds, EVIDENCE_EVENT_LIMIT)
    if (raw.length >= EVIDENCE_EVENT_LIMIT) truncated = true
    events.push(...parseRows(HermesEvidenceEventSchema, raw, counter))
  }
  return { events, truncated }
}

function tasksFor(
  db: DatabaseSync,
  attempts: readonly HermesAttempt[],
  counter: { malformed: number },
): HermesTaskRow[] {
  const ids = [...new Set(attempts.map((attempt) => attempt.task_id))]
  const out: HermesTaskRow[] = []
  for (const chunk of chunks(ids, IN_BATCH)) {
    const raw = db
      .prepare(
        `SELECT id, title, status, assignee, started_at FROM tasks WHERE id IN (${placeholders(chunk.length)})`,
      )
      .all(...chunk)
    out.push(...parseRows(HermesTaskRowSchema, raw, counter))
  }
  return out
}

/**
 * One capture = one read transaction (v5.1 #2): sqlite_sequence marks, min/max probes, page rows, evidence events,
 * task rows and the identity sample all come from the same snapshot, so a concurrent Hermes write cannot make a page
 * look inconsistent with its marks. Every query is a primary-key range, an `IN` list of known ids, or the
 * task_id index; none scans task_runs or task_events.
 */
export function readCapture(
  db: DatabaseSync,
  request: CaptureRequest,
  hooks: ReaderHooks = {},
): Capture {
  const counter = { malformed: 0 }
  db.exec('BEGIN')
  try {
    const marks = readMarks(db)
    hooks.between?.('marks')
    let events: { id: number; runId: number | null }[] = []
    let eventFrom: number | null = null
    let eventTo: number | null = null
    let eventScanned: number | null = null
    let attempts: HermesAttempt[] = []
    let requestedIds: number[] = []
    let range: Capture['range'] = null
    if (request.kind === 'tail') {
      const after = request.afterEventId ?? 0
      const raw = db
        .prepare('SELECT id, run_id FROM task_events WHERE id > ? ORDER BY id LIMIT ?')
        .all(after, request.eventLimit ?? EVENT_PAGE)
      const EventRef = z.object({ id: z.int().positive(), run_id: z.int().nullable() })
      const rows = parseRows(EventRef, raw, counter)
      events = rows.map((row) => ({ id: row.id, runId: row.run_id }))
      // A malformed row must not stall the tail: the scan position advances past it.
      eventScanned = z.int().positive().nullable().parse(
        raw.reduce<number | null>((max, row) => {
          const id = (row as { id?: unknown }).id
          return typeof id === 'number' && Number.isInteger(id) ? Math.max(max ?? 0, id) : max
        }, null),
      )
      eventFrom = rows[0]?.id ?? null
      eventTo = rows.at(-1)?.id ?? null
      // Recently closed attempts: exactly the ids the last tail events touched.
      requestedIds = [
        ...new Set(rows.flatMap((row) => (row.run_id && row.run_id > 0 ? [row.run_id] : []))),
      ]
      hooks.between?.('events')
      attempts = attemptsByIds(db, requestedIds, counter)
    } else if (request.kind === 'sweep') {
      requestedIds = [...new Set(request.openIds ?? [])]
      attempts = attemptsByIds(db, requestedIds, counter)
    } else {
      const from = request.afterAttemptId ?? 0
      const limit = request.attemptLimit ?? ATTEMPT_PAGE
      const raw = db
        .prepare(`SELECT ${COLUMNS} FROM task_runs WHERE id > ? ORDER BY id LIMIT ?`)
        .all(from, limit)
      attempts = parseRows(HermesAttemptSchema, raw, counter)
      const last = z
        .array(z.object({ id: z.int().positive() }))
        .parse(raw)
        .at(-1)?.id
      // A short page reached the end of the table; the window then covers everything above `from`.
      range = { from, to: raw.length < limit ? null : (last ?? from) }
    }
    hooks.between?.('attempts')
    const sampleIds = request.sampleIds ?? []
    const sample = sampleIds.length ? attemptsByIds(db, sampleIds, counter) : []
    const everyAttempt = [...attempts, ...sample]
    const evidence = everyAttempt.length
      ? evidenceFor(db, everyAttempt, counter)
      : { events: [], truncated: false }
    hooks.between?.('evidence')
    const tasks = tasksFor(db, everyAttempt, counter)
    db.exec('COMMIT')
    return {
      captureId: randomUUID(),
      kind: request.kind,
      historyId: request.historyId,
      sourceId: request.sourceId,
      capturedAt: (hooks.now?.() ?? new Date()).toISOString(),
      fileIdentity: request.fileIdentity,
      marks,
      events,
      eventFrom,
      eventTo,
      eventScanned,
      attempts,
      requestedIds,
      range,
      sample,
      sampleIds: [...sampleIds],
      evidenceEvents: evidence.events,
      evidenceTruncated: evidence.truncated,
      tasks,
      malformed: counter.malformed,
    }
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK')
    throw error
  }
}

/** Query shapes for the plan assertions (kept next to the reader so a change shows up in one place). */
export function plannedQueries(): { name: string; sql: string; params: SQLInputValue[] }[] {
  return [
    {
      name: 'tail events',
      sql: 'SELECT id, run_id FROM task_events WHERE id > ? ORDER BY id LIMIT ?',
      params: [0, EVENT_PAGE],
    },
    {
      name: 'attempt page',
      sql: `SELECT ${COLUMNS} FROM task_runs WHERE id > ? ORDER BY id LIMIT ?`,
      params: [0, ATTEMPT_PAGE],
    },
    {
      name: 'attempts by id',
      sql: `SELECT ${COLUMNS} FROM task_runs WHERE id IN (?, ?) ORDER BY id`,
      params: [1, 2],
    },
    {
      name: 'evidence events',
      sql: `SELECT ${EVENT_COLUMNS} FROM task_events
         WHERE task_id IN (?, ?) AND (kind IN (?, ?, ?, ?) OR run_id IN (?, ?)) ORDER BY id LIMIT ?`,
      params: ['a', 'b', 'created', 'claimed', 'spawned', 'worker_registered', 1, 2, 10],
    },
    {
      name: 'tasks by id',
      sql: 'SELECT id, title, status, assignee, started_at FROM tasks WHERE id IN (?, ?)',
      params: ['a', 'b'],
    },
    { name: 'event probes', sql: 'SELECT MIN(id) AS lo, MAX(id) AS hi FROM task_events', params: [] },
    { name: 'run probes', sql: 'SELECT MIN(id) AS lo, MAX(id) AS hi FROM task_runs', params: [] },
  ]
}
