import type { DatabaseSync } from 'node:sqlite'

// Test-only (e2e/demos): Kanban attempts for the fake adapter, written straight into Score's own tables because the
// fake adapter has no Kanban board to project from. Used only when SCORE_MODE=fake, SCORE_KANBAN_ATTEMPTS=1 and
// SCORE_E2E_SEED_ATTEMPTS=1 are all set. Times are relative to the start so they fall inside Now's window.

const SOURCE = 'ks_e2e'
const LIVE = 'kh_e2e_live'
const OLD = 'kh_e2e_old'

interface Seed {
  n: number
  task: string
  profile: string | null
  role: 'implementer' | 'reviewer' | null
  status: string
  startMin: number
  endMin: number | null
  evidence: 'proven' | 'partial'
  history: string
  /** Minutes before now at which observation stopped. */
  lostMin?: number
  title: string
}

const SEEDS: Seed[] = [
  {
    n: 1,
    task: 'task-e2e-a',
    profile: 'builder',
    role: 'implementer',
    status: 'completed',
    startMin: -50,
    endMin: -36,
    evidence: 'proven',
    history: LIVE,
    title: 'Pagination, attempt one',
  },
  {
    n: 2,
    task: 'task-e2e-b',
    profile: null,
    role: null,
    status: 'completed',
    startMin: -34,
    endMin: -20,
    evidence: 'partial',
    history: LIVE,
    title: 'Unclaimed cleanup',
  },
  {
    n: 3,
    task: 'task-e2e-c',
    profile: 'reviewer',
    role: 'reviewer',
    status: 'running',
    startMin: -26,
    endMin: null,
    evidence: 'proven',
    history: LIVE,
    lostMin: 12,
    title: 'Review of the feed',
  },
  {
    n: 4,
    task: 'task-e2e-old',
    profile: 'designer',
    role: 'implementer',
    status: 'failed',
    startMin: -45,
    endMin: -40,
    evidence: 'proven',
    history: OLD,
    title: 'Old board job',
  },
]

export const e2eAttemptId = (n: number) =>
  `kr_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

export function seedFakeAttempts(sqlite: DatabaseSync, nowMs = Date.now()): void {
  const iso = (ms: number) => new Date(ms).toISOString()
  const sec = (min: number) => Math.floor((nowMs + min * 60_000) / 1000)
  sqlite
    .prepare(
      "INSERT OR IGNORE INTO kanban_sources (id, path, board, first_seen) VALUES (?, '/fake/kanban.db', 'default', ?)",
    )
    .run(SOURCE, iso(nowMs - 3_600_000))
  const history = sqlite.prepare(
    `INSERT OR IGNORE INTO kanban_histories (id, source_id, opened_at, state, closed_at, baseline_done)
     VALUES (?, ?, ?, ?, ?, 1)`,
  )
  history.run(OLD, SOURCE, iso(nowMs - 7_200_000), 'closed', iso(nowMs - 3_600_000))
  history.run(LIVE, SOURCE, iso(nowMs - 3_600_000), 'active', null)
  const insert = sqlite.prepare(
    `INSERT OR IGNORE INTO kanban_attempts
       (id, source_id, history_id, attempt_id, task_id, profile, role, status, closure_reason, started_at, ended_at,
        first_seen_open, evidence, classification_basis, task_snapshot, revision, content_hash, copied_from,
        first_seen, last_observed_at, observing, observation_ended_at, deleted_upstream_at, refused_updates)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'e2e', ?, 1, 'h', NULL, ?, ?, ?, ?, NULL, 0)`,
  )
  for (const seed of SEEDS) {
    insert.run(
      e2eAttemptId(seed.n),
      SOURCE,
      seed.history,
      seed.n,
      seed.task,
      seed.profile,
      seed.role,
      seed.status,
      seed.endMin === null ? null : seed.status,
      sec(seed.startMin),
      seed.endMin === null ? null : sec(seed.endMin),
      seed.evidence,
      JSON.stringify({ title: seed.title, status: seed.status, assignee: seed.profile }),
      iso(nowMs - 3_600_000),
      iso(nowMs),
      seed.lostMin === undefined && seed.endMin === null ? 1 : 0,
      seed.lostMin === undefined ? null : iso(nowMs - seed.lostMin * 60_000),
    )
  }
}
