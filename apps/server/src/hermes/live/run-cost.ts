import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import type { ScoreDb } from '../../db/index.ts'
import { endSubagentRow, setSubagentCost } from '../../domain/subagent-rows.ts'
import type { DomainEventDraft, Observation } from '../../hub/ingest.ts'
import type { ObservationSink } from '../port.ts'
import { hermesPaths, resolveHermesHome } from './paths.ts'
import { closeReadOnly, HermesDbMissing, HermesSchemaDrift, openReadOnly } from './sqlite.ts'
import { readRun, runDraft } from './translate-runs.ts'

// A Hermes run's dollars (decision 173, check 2). Hermes' run events carry none, so a job's budget saw "unknown" for every
// Hermes run. They are on its session rows: each row holds its own calls, and a subagent or a compression continuation is a
// row of its own linked by parent_session_id, so the sum over the tree is the session's total so far.

const SessionRowSchema = z.object({
  id: z.string(),
  parent_session_id: z.string().nullable(),
  started_at: z.number(),
  cost_status: z.string().nullable(),
  estimated_cost_usd: z.number().nullable(),
  actual_cost_usd: z.number().nullable(),
  input_tokens: z.int().nullable(),
  output_tokens: z.int().nullable(),
  api_call_count: z.int().nullable(),
})

export interface SessionTreeCost {
  /** Null when any row's cost is unknown: unknown spend is never zero. */
  usd: number | null
  estimated: boolean
  startedAtMs: number
  /** Each row below the session: a subagent's (a continuation has no subagent row, and is skipped when applied). */
  children: { id: string; usd: number | null; tokens: number }[]
}

const MAX_TREE_ROWS = 2000

/** A row whose status is `unknown` says 0.0: that isn't a price (Hermes doesn't know the model's), so it isn't zero. */
function rowCost(
  row: z.infer<typeof SessionRowSchema>,
): { usd: number; estimated: boolean } | null {
  if (row.cost_status === 'included') return { usd: 0, estimated: false }
  if (row.actual_cost_usd !== null) return { usd: row.actual_cost_usd, estimated: false }
  if (row.cost_status === 'estimated' && row.estimated_cost_usd !== null)
    return { usd: row.estimated_cost_usd, estimated: true }
  // A session that never reached the model cost nothing, whatever its status says.
  // No counted calls, not merely no counted tokens: a reply can arrive with its usage missing.
  return !row.api_call_count && !row.input_tokens && !row.output_tokens
    ? { usd: 0, estimated: false }
    : null
}

export function readSessionTreeCost(db: DatabaseSync, sessionId: string): SessionTreeCost | null {
  const rows = z.array(SessionRowSchema).parse(
    db
      .prepare(
        `WITH RECURSIVE tree(id) AS (
           SELECT id FROM sessions WHERE id = ?
           UNION SELECT s.id FROM sessions s JOIN tree t ON s.parent_session_id = t.id
         )
         SELECT s.id, s.parent_session_id, s.started_at, s.cost_status, s.estimated_cost_usd, s.actual_cost_usd, s.input_tokens, s.output_tokens, s.api_call_count
         FROM sessions s JOIN tree t ON s.id = t.id ORDER BY s.started_at LIMIT ?`,
      )
      .all(sessionId, MAX_TREE_ROWS + 1),
  )
  const first = rows.find((row) => row.id === sessionId)
  if (!first) return null
  const costs = rows.map(rowCost)
  const known = rows.length <= MAX_TREE_ROWS && costs.every((cost) => cost !== null)
  return {
    usd: known ? costs.reduce((total, cost) => total + cost!.usd, 0) : null,
    estimated: costs.some((cost) => cost?.estimated),
    startedAtMs: first.started_at * 1000,
    children: rows.flatMap((row, index) =>
      row.id === sessionId
        ? []
        : [
            {
              id: row.id,
              usd: costs[index]?.usd ?? null,
              tokens: (row.input_tokens ?? 0) + (row.output_tokens ?? 0),
            },
          ],
    ),
  }
}

const EarlierRunSchema = z.object({ cost_usd: z.number().nullable() })

/**
 * A session is shared by a chat's turns and its cost is cumulative, so a run costs what the session has reached minus
 * what its earlier runs were given. If an earlier run has no figure, or the session began before Score's first run in it
 * (a room continuing an outside session), that difference would charge this run for someone else's spending: unknown.
 */
export function runCostObservation(
  runId: string,
  cost: SessionTreeCost,
  round: number,
  startTolerance = 2000,
): Observation {
  return {
    source: 'run-cost',
    identity: `run_cost:${runId}:${round}`,
    apply({ sqlite, now }) {
      const row = readRun(sqlite, runId)
      const children = cost.children.flatMap((child) =>
        setSubagentCost(sqlite, child.id, child.usd, child.tokens),
      )
      // Stop kills a subagent with no word from it. By the second read, one still marked running has ended.
      const stopped =
        round > 0
          ? cost.children.flatMap((child) => endSubagentRow(sqlite, child.id, 'failed', now))
          : []
      return [...children, ...stopped, ...settleRun(sqlite, row, cost, now, startTolerance)]
    },
  }
}

function settleRun(
  sqlite: DatabaseSync,
  row: ReturnType<typeof readRun>,
  cost: SessionTreeCost,
  now: string,
  startTolerance: number,
): DomainEventDraft[] {
  if (row.session_id === null) return []
  const others = (order: string) =>
    z.array(EarlierRunSchema).parse(
      sqlite
        .prepare(
          `SELECT cost_usd FROM runs
               WHERE profile = ? AND session_id = ? AND id != ? AND (started_at ${order} ?)`,
        )
        .all(row.profile, row.session_id, row.id, row.started_at),
    )
  // A later turn has begun: the session's total now includes it, so this run keeps the figure it has.
  if (others('>').length > 0) return []
  const earlier = others('<=')
  const outside =
    earlier.length === 0 && cost.startedAtMs < Date.parse(row.started_at) - startTolerance
  const usd =
    cost.usd === null || outside || earlier.some((run) => run.cost_usd === null)
      ? null
      : Math.max(0, cost.usd - earlier.reduce((total, run) => total + run.cost_usd!, 0))
  const kind = usd === null ? 'unknown' : cost.estimated ? 'estimated' : null
  if (usd === row.cost_usd && kind === row.cost_kind) return []
  // Not updateRun: a run's terminal row is closed to status changes, and this is the one fact that comes after it.
  sqlite
    .prepare(
      'UPDATE runs SET cost_usd = ?, cost_kind = ?, version = version + 1, updated_at = ? WHERE id = ?',
    )
    .run(usd, kind, now, row.id)
  return [runDraft(sqlite, row.id)]
}

/** When Hermes says a session began; null when it has no such session, or can't be read. */
export function hermesSessionStartedAt(
  profile: string,
  sessionId: string,
  hermesHome: string | undefined,
): number | null {
  try {
    const db = openReadOnly(hermesPaths(resolveHermesHome(hermesHome)).stateDb(profile))
    try {
      const row = db.prepare('SELECT started_at FROM sessions WHERE id = ?').get(sessionId) as
        { started_at: number } | undefined
      return row ? row.started_at * 1000 : null
    } finally {
      closeReadOnly(db)
    }
  } catch {
    return null
  }
}

function readTreeCost(
  profile: string,
  sessionId: string,
  hermesHome: string | undefined,
): SessionTreeCost | null {
  try {
    const db = openReadOnly(hermesPaths(resolveHermesHome(hermesHome)).stateDb(profile))
    try {
      return readSessionTreeCost(db, sessionId)
    } finally {
      closeReadOnly(db)
    }
  } catch (error) {
    if (error instanceof HermesDbMissing || error instanceof HermesSchemaDrift) return null
    throw error
  }
}

/** Hermes queues its usage writes, so a turn's last call can land just after the turn ends: read now, and again shortly. */
export const COST_REREAD_MS = 5000

export async function settleRunCost(options: {
  db: ScoreDb
  sink: ObservationSink
  signal: AbortSignal
  hermesHome: string | undefined
  runId: string
  wait: (ms: number, signal?: AbortSignal) => Promise<void>
}): Promise<void> {
  const { db, sink, signal, hermesHome, runId, wait } = options
  for (const round of [0, 1]) {
    if (round > 0) await wait(COST_REREAD_MS, signal)
    if (signal.aborted) return
    const { profile, session_id: sessionId } = readRun(db.sqlite, runId)
    if (sessionId === null) return
    const cost = readTreeCost(profile, sessionId, hermesHome)
    if (cost) await sink.submit(runCostObservation(runId, cost, round))
  }
}
