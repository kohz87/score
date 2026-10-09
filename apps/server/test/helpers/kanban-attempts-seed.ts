import type { DatabaseSync } from 'node:sqlite'

// Direct rows for the stage 2a consumer tests: the projection itself is covered by the stage 1 tests, so consumers
// are exercised against exact stored states (including ones that are hard to reach through a fake board).

export const FLAG = 'SCORE_KANBAN_ATTEMPTS'
export function withFlag(on: boolean): void {
  if (on) process.env[FLAG] = '1'
  else delete process.env[FLAG]
}

export function seedHistory(
  sqlite: DatabaseSync,
  options: { source?: string; history?: string; state?: 'active' | 'paused' | 'closed' } = {},
): { source: string; history: string } {
  const source = options.source ?? 'ks_test'
  const history = options.history ?? 'kh_test'
  sqlite
    .prepare(
      "INSERT OR IGNORE INTO kanban_sources (id, path, board, first_seen) VALUES (?, '/x/kanban.db', 'default', '2026-10-01T00:00:00.000Z')",
    )
    .run(source)
  sqlite
    .prepare(
      `INSERT INTO kanban_histories (id, source_id, opened_at, state, closed_at, baseline_done)
       VALUES (?, ?, '2026-10-01T00:00:00.000Z', ?, ?, 1)`,
    )
    .run(
      history,
      source,
      options.state ?? 'active',
      options.state === 'closed' ? '2026-10-05T00:00:00.000Z' : null,
    )
  return { source, history }
}

export interface SeedAttempt {
  id?: string
  attempt: number
  task: string
  profile?: string | null
  role?: 'implementer' | 'reviewer' | null
  status?: string
  closure?: string | null
  /** Epoch seconds. */
  start: number
  end?: number | null
  evidence?: 'proven' | 'partial'
  source?: string
  history?: string
  observing?: 0 | 1
  observationEndedAt?: string | null
  copiedFrom?: string | null
  /** ISO; copies pick the newest row of a group by this. */
  firstSeen?: string
  /** Observed stretches (ISO); default is derived: start to end, else to the observation boundary, else open. */
  intervals?: { startedAt: string; endedAt: string | null }[]
  deletedUpstreamAt?: string | null
  snapshot?: { title: string; status: string; assignee: string | null } | null
  refused?: number
}

export function seedAttempt(sqlite: DatabaseSync, a: SeedAttempt): string {
  const id = a.id ?? `kr_00000000-0000-4000-8000-${String(a.attempt).padStart(12, '0')}`
  const end = a.end === undefined ? null : a.end
  const status = a.status ?? (end === null ? 'running' : 'completed')
  sqlite
    .prepare(
      `INSERT INTO kanban_attempts
         (id, source_id, history_id, attempt_id, task_id, profile, role, status, closure_reason, started_at, ended_at,
          first_seen_open, evidence, classification_basis, task_snapshot, revision, content_hash, copied_from,
          first_seen, last_observed_at, observing, observation_ended_at, deleted_upstream_at, refused_updates)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'seed', ?, 1, 'h', ?, ?,
               '2026-10-01T00:00:00.000Z', ?, ?, ?, ?)`,
    )
    .run(
      id,
      a.source ?? 'ks_test',
      a.history ?? 'kh_test',
      a.attempt,
      a.task,
      a.profile === undefined ? 'builder' : a.profile,
      a.role === undefined ? 'implementer' : a.role,
      status,
      a.closure === undefined ? (end === null ? null : status) : a.closure,
      a.start,
      end,
      a.evidence ?? 'proven',
      a.snapshot === undefined
        ? JSON.stringify({ title: `Snapshot of ${a.task}`, status: 'done', assignee: 'builder' })
        : a.snapshot === null
          ? null
          : JSON.stringify(a.snapshot),
      a.copiedFrom ?? null,
      a.firstSeen ?? '2026-10-01T00:00:00.000Z',
      a.observing ?? (end === null && !a.observationEndedAt ? 1 : 0),
      a.observationEndedAt ?? null,
      a.deletedUpstreamAt ?? null,
      a.refused ?? 0,
    )
  const stored =
    a.intervals ??
    (a.observationEndedAt && end === null
      ? [{ startedAt: new Date(a.start * 1000).toISOString(), endedAt: a.observationEndedAt }]
      : undefined)
  if (stored) {
    sqlite.prepare('DELETE FROM kanban_attempt_observations WHERE attempt_id = ?').run(id)
    stored.forEach((interval, seq) =>
      sqlite
        .prepare(
          'INSERT INTO kanban_attempt_observations (attempt_id, seq, started_at, ended_at) VALUES (?, ?, ?, ?)',
        )
        .run(id, seq, interval.startedAt, interval.endedAt),
    )
  }
  return id
}
