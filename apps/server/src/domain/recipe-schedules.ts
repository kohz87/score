import type { DatabaseSync } from 'node:sqlite'
import {
  ORCH_ACKNOWLEDGEMENT_TEXT,
  RecipeScheduleSchema,
  type RecipeSchedule,
  type RecipeScheduleRequest,
  type WorkflowRunCreate,
} from '@score/contract'
import { z } from 'zod'
import { HttpError } from '../errors.ts'
import { nextFire } from './schedule-next.ts'
import { teamPausedAt } from './team-pause.ts'
import { readVersion } from './workflows/definitions.ts'

// Decision 183: a recipe repeats on a schedule Score runs. One run per fire, started as a job in the schedule's chat and
// bound to what the person saw when setting it. Score has to be running at that time: a fire found later than
// GRACE_MS is recorded as missed (with how many were missed) and never run late on its own (Run now starts one).

/** Two ticks: a fire found later than this was due while Score wasn't running. */
export const GRACE_MS = 90_000

const RowSchema = z.object({
  workflow_id: z.string(),
  schedule: z.string(),
  timezone: z.string(),
  room_id: z.string(),
  enabled: z.number(),
  agent_map: z.string(),
  anchor_at: z.string(),
  next_run_at: z.string().nullable(),
  last_at: z.string().nullable(),
  last_outcome: z.enum(['started', 'missed', 'failed']).nullable(),
  last_brief_id: z.string().nullable(),
  last_reason: z.string().nullable(),
  recipe_name: z.string().nullable(),
  room_name: z.string().nullable(),
})
type Row = z.infer<typeof RowSchema>

const SELECT = `SELECT s.*, d.name AS recipe_name, r.name AS room_name FROM recipe_schedules s
  LEFT JOIN workflow_definitions d ON d.id = s.workflow_id LEFT JOIN rooms r ON r.id = s.room_id`

function toSchedule(row: Row): RecipeSchedule {
  return RecipeScheduleSchema.parse({
    workflowId: row.workflow_id,
    recipeName: row.recipe_name ?? 'A removed recipe',
    schedule: row.schedule,
    timezone: row.timezone,
    roomId: row.room_id,
    roomName: row.room_name ?? 'A removed chat',
    enabled: row.enabled === 1,
    nextRunAt: row.enabled === 1 ? row.next_run_at : null,
    lastRun:
      row.last_at && row.last_outcome
        ? {
            at: row.last_at,
            outcome: row.last_outcome,
            briefId: row.last_brief_id,
            reason: row.last_reason,
          }
        : null,
  })
}

export function recipeSchedules(sqlite: DatabaseSync): RecipeSchedule[] {
  return z
    .array(RowSchema)
    .parse(sqlite.prepare(`${SELECT} ORDER BY d.name`).all())
    .map(toSchedule)
}

export function recipeSchedule(sqlite: DatabaseSync, workflowId: string): RecipeSchedule | null {
  const row = sqlite.prepare(`${SELECT} WHERE s.workflow_id = ?`).get(workflowId)
  return row ? toSchedule(RowSchema.parse(row)) : null
}

function latestVersion(sqlite: DatabaseSync, workflowId: string): number {
  const row = sqlite
    .prepare('SELECT MAX(version) AS v FROM workflow_versions WHERE workflow_id = ?')
    .get(workflowId) as { v: number | null }
  if (row.v === null) throw new HttpError(404, 'not_found', 'Couldn’t find that recipe.')
  return row.v
}

/** What only a schedule can't do: a run Score starts alone can't ask for inputs or confirm coding settings. */
export function assertCanRepeat(sqlite: DatabaseSync, workflowId: string): void {
  const header = sqlite
    .prepare('SELECT archived_at FROM workflow_definitions WHERE id = ?')
    .get(workflowId) as { archived_at: string | null } | undefined
  if (!header) throw new HttpError(404, 'not_found', 'Couldn’t find that recipe.')
  if (header.archived_at)
    throw new HttpError(400, 'bad_request', 'An archived recipe can’t repeat.')
  const version = readVersion(sqlite, workflowId, latestVersion(sqlite, workflowId))
  // A run Score starts alone gives no inputs, so a recipe that takes any (required or not) doesn't repeat.
  if (version.definition.inputs.length > 0)
    throw new HttpError(
      400,
      'bad_request',
      'This recipe asks for inputs when it starts, so it can’t repeat yet.',
    )
  const coding = version.definition.nodes.some(
    (node) =>
      node.kind === 'agent' &&
      sqlite.prepare('SELECT 1 FROM coding_agents WHERE id = ?').get(node.agentId) !== undefined,
  )
  if (coding)
    throw new HttpError(
      400,
      'bad_request',
      'This recipe has coding steps, which need their settings confirmed each run, so it can’t repeat yet.',
    )
}

export function setRecipeSchedule(
  sqlite: DatabaseSync,
  workflowId: string,
  req: RecipeScheduleRequest,
  now: string,
): RecipeSchedule {
  // Pausing keeps what the schedule was bound to; setting it, changing it or turning it on needs what the person saw.
  const stored = sqlite
    .prepare(
      'SELECT schedule, timezone, room_id, agent_map FROM recipe_schedules WHERE workflow_id = ?',
    )
    .get(workflowId) as
    { schedule: string; timezone: string; room_id: string; agent_map: string } | undefined
  const pausingOnly =
    stored !== undefined &&
    !req.enabled &&
    stored.schedule === req.schedule &&
    stored.timezone === req.timezone &&
    stored.room_id === req.roomId
  if ((!req.agentMap || !req.acknowledgement) && !pausingOnly)
    throw new HttpError(
      400,
      'bad_request',
      'Show the recipe’s agents and the acknowledgement again to set or resume its schedule.',
    )
  const agentMap = req.agentMap ? JSON.stringify(req.agentMap) : stored!.agent_map
  assertCanRepeat(sqlite, workflowId)
  if (!sqlite.prepare('SELECT 1 FROM rooms WHERE id = ?').get(req.roomId))
    throw new HttpError(400, 'bad_request', 'Couldn’t find that chat.')
  const next = nextFire(req.schedule, req.timezone, new Date(now))
  if (!next) throw new HttpError(400, 'bad_request', 'That schedule never fires.')
  sqlite
    .prepare(
      `INSERT INTO recipe_schedules (workflow_id, schedule, timezone, room_id, enabled, agent_map, anchor_at, next_run_at, set_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (workflow_id) DO UPDATE SET schedule = excluded.schedule, timezone = excluded.timezone,
         room_id = excluded.room_id, enabled = excluded.enabled, agent_map = excluded.agent_map,
         anchor_at = excluded.anchor_at, next_run_at = excluded.next_run_at, set_at = excluded.set_at`,
    )
    .run(
      workflowId,
      req.schedule,
      req.timezone,
      req.roomId,
      req.enabled ? 1 : 0,
      agentMap,
      now,
      next.toISOString(),
      now,
    )
  return recipeSchedule(sqlite, workflowId)!
}

export function removeRecipeSchedule(sqlite: DatabaseSync, workflowId: string): void {
  sqlite.prepare('DELETE FROM recipe_schedules WHERE workflow_id = ?').run(workflowId)
}

/** The run a fire starts: the latest version, no inputs, the agents and acknowledgement the person saw. */
export function scheduledRun(
  sqlite: DatabaseSync,
  workflowId: string,
  now: string,
): WorkflowRunCreate {
  const row = RowSchema.parse(sqlite.prepare(`${SELECT} WHERE s.workflow_id = ?`).get(workflowId))
  const day = new Intl.DateTimeFormat('en-GB', {
    timeZone: row.timezone,
    day: 'numeric',
    month: 'short',
  }).format(new Date(now))
  return {
    workflowId,
    version: latestVersion(sqlite, workflowId),
    inputs: {},
    agentMap: z
      .array(z.object({ agentId: z.string(), incarnation: z.string() }))
      .parse(JSON.parse(row.agent_map)),
    gatePolicy: 'gates-only',
    unknownSpend: 'pause',
    maxConcurrentSteps: 2,
    stepEstimateUsd: 0.5,
    acknowledgement: { text: ORCH_ACKNOWLEDGEMENT_TEXT },
    topic: { roomId: row.room_id, title: `${row.recipe_name ?? 'Recipe'} · ${day}` },
  }
}

/** Records what a fire did and moves the schedule to its next time. */
export function recordFire(
  sqlite: DatabaseSync,
  workflowId: string,
  fire: {
    at: string
    outcome: 'started' | 'missed' | 'failed'
    briefId?: string
    reason?: string
    /** For `missed`: how many fires went by while Score wasn't running. */
    missed?: number
  },
  now: string,
): void {
  const row = sqlite
    .prepare('SELECT schedule, timezone, anchor_at FROM recipe_schedules WHERE workflow_id = ?')
    .get(workflowId) as { schedule: string; timezone: string; anchor_at: string } | undefined
  if (!row) return
  const after = new Date(Math.max(Date.parse(now), Date.parse(fire.at)))
  const next = nextFire(row.schedule, row.timezone, after, new Date(row.anchor_at))
  sqlite
    .prepare(
      `UPDATE recipe_schedules SET last_at = ?, last_outcome = ?, last_brief_id = ?, last_reason = ?, next_run_at = ?
       WHERE workflow_id = ?`,
    )
    .run(
      fire.at,
      fire.outcome,
      fire.briefId ?? null,
      fire.reason ??
        (fire.outcome === 'missed' && (fire.missed ?? 1) > 1
          ? `${fire.missed} runs were missed while Score wasn’t running.`
          : null),
      next?.toISOString() ?? null,
      workflowId,
    )
}

/** The fires due now: on time ones to start, and late ones (Score wasn't running) to record as missed. */
export function dueFires(
  sqlite: DatabaseSync,
  now: string,
): { workflowId: string; at: string; late: boolean; missed: number }[] {
  const rows = sqlite
    .prepare(
      `SELECT workflow_id, next_run_at FROM recipe_schedules
       WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at`,
    )
    .all(now) as { workflow_id: string; next_run_at: string }[]
  return rows.map((row) => {
    const late = Date.parse(now) - Date.parse(row.next_run_at) > GRACE_MS
    return {
      workflowId: row.workflow_id,
      at: row.next_run_at,
      late,
      missed: late ? missedCount(sqlite, row.workflow_id, row.next_run_at, now) : 0,
    }
  })
}

/** How many fires fell between the first missed one and now (bounded: a long outage reads "100 runs"). */
function missedCount(sqlite: DatabaseSync, workflowId: string, first: string, now: string): number {
  const row = sqlite
    .prepare('SELECT schedule, timezone, anchor_at FROM recipe_schedules WHERE workflow_id = ?')
    .get(workflowId) as { schedule: string; timezone: string; anchor_at: string }
  let count = 1
  let at = new Date(first)
  while (count < 100) {
    const next = nextFire(row.schedule, row.timezone, at, new Date(row.anchor_at))
    if (!next || next.getTime() > Date.parse(now)) break
    count += 1
    at = next
  }
  return count
}

/** Why a fire can't start now, in plain words: the recipe was archived, the chat is gone, or work is paused. */
export function cannotFire(sqlite: DatabaseSync, workflowId: string): string | null {
  const row = sqlite
    .prepare(
      `SELECT d.archived_at, (SELECT 1 FROM rooms r WHERE r.id = s.room_id) AS room FROM recipe_schedules s
       LEFT JOIN workflow_definitions d ON d.id = s.workflow_id WHERE s.workflow_id = ?`,
    )
    .get(workflowId) as { archived_at: string | null; room: number | null } | undefined
  if (!row) return 'This recipe doesn’t repeat.'
  if (row.archived_at) return 'The recipe was archived.'
  if (!row.room) return 'Its chat was deleted.'
  if (teamPausedAt(sqlite) !== null) return 'Work was paused.'
  return null
}

/** The claimed fire's run, once it exists. */
export function noteStarted(
  sqlite: DatabaseSync,
  workflowId: string,
  at: string,
  briefId: string,
): void {
  sqlite
    .prepare(
      "UPDATE recipe_schedules SET last_brief_id = ? WHERE workflow_id = ? AND last_at = ? AND last_outcome = 'started'",
    )
    .run(briefId, workflowId, at)
}

/** The claimed fire couldn't start after all: what the person sees says why (the schedule has already moved on). */
export function noteFailed(
  sqlite: DatabaseSync,
  workflowId: string,
  at: string,
  reason: string,
): void {
  sqlite
    .prepare(
      "UPDATE recipe_schedules SET last_outcome = 'failed', last_reason = ? WHERE workflow_id = ? AND last_at = ?",
    )
    .run(reason, workflowId, at)
}
