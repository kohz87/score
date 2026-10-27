// 3.13 (decision 150): the oracle's records. A job's check is set by the person (check_json); each run of it is a row in
// orc_checks. Only the executor starts and ends runs (serviceChecks); everything here is a pure database step.

import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { CheckRunView } from '@score/contract'
import { z } from 'zod'
import { HttpError } from '../../errors.ts'
import type { Ctx } from './ctx.ts'
import { touch } from './ctx.ts'
import { redact } from '../../redact.ts'
import { joinCommand } from './check-command.ts'
import { addCause, addHistory, type OrchRow } from './store.ts'

export const CheckConfigSchema = z.object({
  argv: z.array(z.string()).min(1),
  workspace: z.string().min(1),
  timeoutSec: z.int().positive(),
  when: z.enum(['finish', 'each_step']),
})
export type CheckConfig = z.infer<typeof CheckConfigSchema>

const CheckRowSchema = z.object({
  id: z.string(),
  orchestration_id: z.string(),
  reason: z.enum(['lead', 'step', 'person']),
  queued_at: z.string(),
  started_at: z.string().nullable(),
  ended_at: z.string().nullable(),
  exit_code: z.int().nullable(),
  outcome: z.enum([
    'queued',
    'running',
    'passed',
    'failed',
    'timed_out',
    'interrupted',
    'refused',
    'cancelled',
  ]),
  output: z.string(),
})
export type CheckRow = z.infer<typeof CheckRowSchema>

/** What Score keeps of a run's output, and the part the lead reads. */
export const CHECK_OUTPUT_BYTES = 64 * 1024
/** What one run keeps in the database (the end of its output), and how many runs a job may make: reserved at creation. */
export const CHECK_STORED_BYTES = 16 * 1024
export const MAX_CHECK_RUNS = 30
export const CHECK_RESERVE_BYTES = MAX_CHECK_RUNS * (CHECK_STORED_BYTES + 1024)
export const CHECK_LEAD_BYTES = 8 * 1024

export function checkConfigOf(sqlite: DatabaseSync, orchId: string): CheckConfig | null {
  const row = sqlite.prepare('SELECT check_json FROM orchestrations WHERE id = ?').get(orchId) as
    { check_json: string | null } | undefined
  if (!row?.check_json) return null
  return CheckConfigSchema.parse(JSON.parse(row.check_json))
}

export function checkWaivedAt(sqlite: DatabaseSync, orchId: string): string | null {
  const row = sqlite
    .prepare('SELECT check_waived_at FROM orchestrations WHERE id = ?')
    .get(orchId) as { check_waived_at: string | null } | undefined
  return row?.check_waived_at ?? null
}

/** Newest first. */
export function checksOf(sqlite: DatabaseSync, orchId: string, limit = 50): CheckRow[] {
  return z
    .array(CheckRowSchema)
    .parse(
      sqlite
        .prepare(
          'SELECT * FROM orc_checks WHERE orchestration_id = ? ORDER BY queued_at DESC, rowid DESC LIMIT ?',
        )
        .all(orchId, limit),
    )
}

export const checkPending = (sqlite: DatabaseSync, orchId: string): boolean =>
  sqlite
    .prepare(
      "SELECT 1 FROM orc_checks WHERE orchestration_id = ? AND outcome IN ('queued', 'running') LIMIT 1",
    )
    .get(orchId) !== undefined

/**
 * A run counts for finishing only if it started after every step attempt of the job ended, and none is still going: a
 * pass from before the last change proves nothing about it.
 */
export function checkIsCurrent(sqlite: DatabaseSync, orchId: string, check: CheckRow): boolean {
  if (check.started_at === null) return false
  // Every step counts, the advisor's consults and helpers' work included (3.14–3.16): Hermes can't hold them read-only.
  // Review P1: an attempt Score can't confirm ended (unknown) may still be writing: it counts as not ended. One the
  // person abandoned counts only if that happened after the check started (they settled it before). A created one that
  // was never sent changed nothing (finishing retires it).
  const row = sqlite
    .prepare(
      `SELECT count(*) AS n FROM orc_attempts WHERE orchestration_id = ? AND kind = 'step'
         AND ((terminated_at IS NULL AND state NOT IN ('created', 'refused', 'terminated', 'abandoned'))
              OR terminated_at > ? OR abandoned_at > ?)`,
    )
    .get(orchId, check.started_at, check.started_at) as { n: number }
  return row.n === 0
}

const runsMade = (sqlite: DatabaseSync, orchId: string): number =>
  (
    sqlite
      .prepare(
        "SELECT count(*) AS n FROM orc_checks WHERE orchestration_id = ? AND outcome != 'cancelled'",
      )
      .get(orchId) as { n: number }
  ).n

/**
 * Queues a run unless one is already waiting (a running one gets a fresh run queued behind it). Null when the job has
 * made all the runs its storage was reserved for (review: each run keeps its output).
 */
export function queueCheck(ctx: Ctx, orchId: string, reason: CheckRow['reason']): string | null {
  const waiting = ctx.sqlite
    .prepare("SELECT id FROM orc_checks WHERE orchestration_id = ? AND outcome = 'queued' LIMIT 1")
    .get(orchId) as { id: string } | undefined
  if (waiting) return waiting.id
  if (runsMade(ctx.sqlite, orchId) >= MAX_CHECK_RUNS) return null
  const id = `chk-${randomUUID()}`
  ctx.sqlite
    .prepare(
      "INSERT INTO orc_checks (id, orchestration_id, reason, queued_at, outcome) VALUES (?, ?, ?, ?, 'queued')",
    )
    .run(id, orchId, reason, ctx.now)
  touch(ctx, orchId)
  return id
}

/** After a step succeeded: a check set to run after each step is queued. */
export function queueCheckAfterStep(ctx: Ctx, orchId: string): void {
  if (checkConfigOf(ctx.sqlite, orchId)?.when === 'each_step') queueCheck(ctx, orchId, 'step')
}

/** Why `orch.finish(success)` can't go through yet, or null when it can. */
export function finishRefusal(
  sqlite: DatabaseSync,
  o: OrchRow,
): { code: string; message: string } | null {
  if (checkConfigOf(sqlite, o.id) === null || checkWaivedAt(sqlite, o.id) !== null) return null
  if (checkPending(sqlite, o.id))
    return {
      code: 'check_running',
      message:
        'The check is still running. Score starts a new turn for you with its result; finish after that.',
    }
  const latest = checksOf(sqlite, o.id, 1)[0]
  if (latest?.outcome === 'passed' && checkIsCurrent(sqlite, o.id, latest)) return null
  if (runsMade(sqlite, o.id) >= MAX_CHECK_RUNS)
    return {
      code: 'check_limit',
      message: `The check has run ${MAX_CHECK_RUNS} times, its limit for this job, without a current pass. Finish with outcome partial or failed, or ask the person (they can let it finish).`,
    }
  return {
    code: 'check_required',
    message:
      latest?.outcome === 'passed'
        ? 'The last passing check ran before a step ended. Call orch.check again, or finish with outcome partial or failed.'
        : 'A successful finish needs the person’s check to pass after the last step ended. Call orch.check, or finish with outcome partial or failed.',
  }
}

/** The person runs the check now (the job page). */
export function personRunsCheck(ctx: Ctx, o: OrchRow): void {
  if (checkConfigOf(ctx.sqlite, o.id) === null)
    throw new HttpError(409, 'conflict', 'This job has no check.')
  if (o.status !== 'running' && o.status !== 'paused')
    throw new HttpError(409, 'conflict', `This job is ${o.status}.`)
  if (queueCheck(ctx, o.id, 'person') === null)
    throw new HttpError(
      409,
      'conflict',
      `This job has run its check ${MAX_CHECK_RUNS} times, its limit.`,
    )
  addHistory(ctx.sqlite, o.id, 'check_requested', { by: 'person' }, ctx.now)
}

/** The person lets the job finish successfully without a passing check: recorded, and the lead is told. */
export function waiveCheck(ctx: Ctx, o: OrchRow): void {
  if (checkConfigOf(ctx.sqlite, o.id) === null)
    throw new HttpError(409, 'conflict', 'This job has no check.')
  if (!['running', 'paused'].includes(o.status))
    throw new HttpError(409, 'conflict', `This job is ${o.status}.`)
  if (checkWaivedAt(ctx.sqlite, o.id) !== null) return
  ctx.sqlite
    .prepare('UPDATE orchestrations SET check_waived_at = ? WHERE id = ?')
    .run(ctx.now, o.id)
  addHistory(ctx.sqlite, o.id, 'check_waived', { by: 'person' }, ctx.now)
  addCause(
    ctx.sqlite,
    o.id,
    'check_waived',
    null,
    ctx.now,
    'the person lets you finish without a passing check',
  )
  touch(ctx, o.id)
}

export function checkRunView(sqlite: DatabaseSync, orchId: string, row: CheckRow): CheckRunView {
  return {
    id: row.id,
    reason: row.reason,
    queuedAt: row.queued_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    exitCode: row.exit_code,
    outcome: row.outcome,
    output: row.output,
    current: row.outcome === 'passed' && checkIsCurrent(sqlite, orchId, row),
  }
}

/** The command as one line, redacted (a token typed into it never reaches a page, a history row or the lead) and capped. */
export function shownCommand(argv: readonly string[], maxChars = 1024): string {
  const line = redact(joinCommand(argv))
  return line.length > maxChars ? `${line.slice(0, maxChars)}…` : line
}

export function checkView(sqlite: DatabaseSync, orchId: string) {
  const config = checkConfigOf(sqlite, orchId)
  if (config === null) return null
  return {
    command: shownCommand(config.argv, 4096),
    workspace: config.workspace,
    timeoutSec: config.timeoutSec,
    when: config.when,
    runs: checksOf(sqlite, orchId, 20).map((row) => checkRunView(sqlite, orchId, row)),
    waivedAt: checkWaivedAt(sqlite, orchId),
  }
}

/** The tail of `text` within `bytes`, cut on a character boundary. */
export function tailBytes(text: string, bytes: number): string {
  const buf = Buffer.from(text)
  if (buf.length <= bytes) return text
  return buf
    .subarray(buf.length - bytes)
    .toString('utf8')
    .replace(/^�+/, '')
}
