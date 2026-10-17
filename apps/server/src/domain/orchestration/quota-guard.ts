import type { CodingQuota, QuotaHoldView } from '@score/contract'
import type { DatabaseSync } from 'node:sqlite'
import { getCodingAgent, getCodingQuota } from '../../runtimes/coding/store.ts'
import { belowFloor, type BelowFloor } from '../../runtimes/coding/quota-floor.ts'
import { touch, type Ctx } from './ctx.ts'
import { setStepStatus } from './ops.ts'
import { addCause, addHistory, type OrchRow, type StepRow } from './store.ts'

// The quota guard (PLAN 8.6, decision 91). A coding step whose agent has less than its floor left is held, not failed:
// the step stays `queued` and `orc_quota_holds` says why. Missing, unknown or expired readings never hold anything, and
// a running step is never touched (this module only decides about steps that have not started).

/** Where the guard reads Antigravity's quota (the cached `/usage`); Claude Code and Codex readings are in the database. */
export interface QuotaSource {
  /** The latest `/usage` reading, or null when there is none or it is too old to trust (a failed read never blocks). */
  antigravity(): CodingQuota | null
  /** Reads `/usage` again when the cached one is older than 60 s. Never throws. */
  refresh(): Promise<void>
}

export interface HoldRow {
  orchestration_id: string
  step_id: string
  agent_id: string
  window: '5 hours' | 'week'
  group_name: string | null
  left_percent: number
  resets_at: string
  state: 'held' | 'waiting' | 'override'
  created_at: string
}

/** The floor that applies to an agent in a run: the run's own when it has one, else the agent's. */
export function effectiveFloor(
  o: Pick<OrchRow, 'quota_floor_percent'>,
  agentFloor: number,
): number {
  return o.quota_floor_percent ?? agentFloor
}

/**
 * Whether a coding agent is below its floor in this run, now. Not a coding agent, floor 0, no reading, or an Antigravity
 * reading that isn't fresh: null.
 */
export function quotaCheck(
  sqlite: DatabaseSync,
  source: QuotaSource | undefined,
  o: Pick<OrchRow, 'quota_floor_percent'>,
  agentId: string,
  nowMs: number,
): BelowFloor | null {
  const agent = getCodingAgent(sqlite, agentId)
  if (!agent) return null
  const floor = effectiveFloor(o, agent.quotaFloorPercent)
  if (floor === 0) return null
  const quota =
    agent.runtime === 'antigravity'
      ? (source?.antigravity() ?? null)
      : getCodingQuota(sqlite, agentId)
  return belowFloor(quota, floor, nowMs, agent.model)
}

/** The allowed coding agents (other than `except`) that are not below their floor, for the lead's refusal. */
export function agentsWithRoom(
  sqlite: DatabaseSync,
  source: QuotaSource | undefined,
  o: Pick<OrchRow, 'quota_floor_percent' | 'allowed_agents' | 'lead_agent_id'>,
  except: string,
  nowMs: number,
): string[] {
  return o.allowed_agents.filter(
    (id) =>
      id !== except && id !== o.lead_agent_id && quotaCheck(sqlite, source, o, id, nowMs) === null,
  )
}

export const holdOf = (sqlite: DatabaseSync, orchId: string, stepId: string): HoldRow | undefined =>
  sqlite
    .prepare('SELECT * FROM orc_quota_holds WHERE orchestration_id = ? AND step_id = ?')
    .get(orchId, stepId) as HoldRow | undefined

export const holdsOf = (sqlite: DatabaseSync, orchId: string): HoldRow[] =>
  sqlite
    .prepare(
      'SELECT * FROM orc_quota_holds WHERE orchestration_id = ? ORDER BY created_at, step_id',
    )
    .all(orchId) as unknown as HoldRow[]

export const holdView = (row: HoldRow): QuotaHoldView => ({
  agentId: row.agent_id,
  window: row.window,
  group: row.group_name,
  leftPercent: row.left_percent,
  resetsAt: row.resets_at,
  state: row.state,
})

/** "the 5-hour limit", "the weekly limit", "the Gemini Models 5-hour limit". */
export function windowPhrase(window: BelowFloor['window'], group: string | null): string {
  const base = window === 'week' ? 'weekly limit' : '5-hour limit'
  return group ? `the ${group} ${base}` : `its ${base}`
}

const leftText = (value: number): string => `${Math.round(value * 10) / 10}%`

/** One plain sentence for the lead: "s3 is held: builder has 6% of its 5-hour limit left until 2026-10-17 13:40 UTC." */
export function heldSentence(stepId: string, agentId: string, below: BelowFloor): string {
  const when = below.resetsAt.replace('T', ' ').slice(0, 16)
  return `${stepId} is held: ${agentId} has ${leftText(below.leftPercent)} of ${windowPhrase(below.window, below.group)} left until ${when} UTC.`
}

function writeHold(
  sqlite: DatabaseSync,
  orchId: string,
  stepId: string,
  agentId: string,
  below: BelowFloor,
  state: HoldRow['state'],
  now: string,
): void {
  sqlite
    .prepare(
      `INSERT INTO orc_quota_holds (orchestration_id, step_id, agent_id, window, group_name, left_percent, resets_at, state, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (orchestration_id, step_id) DO UPDATE SET agent_id = excluded.agent_id, window = excluded.window,
         group_name = excluded.group_name, left_percent = excluded.left_percent, resets_at = excluded.resets_at,
         state = excluded.state`,
    )
    .run(
      orchId,
      stepId,
      agentId,
      below.window,
      below.group,
      below.leftPercent,
      below.resetsAt,
      state,
      now,
    )
}

/** A held step keeps its status (queued, or waiting for a gate); its disposition says why. */
function markHeld(sqlite: DatabaseSync, orchId: string, stepId: string, now: string): void {
  sqlite
    .prepare(
      "UPDATE orc_steps SET disposition = 'quota_low', updated_at = ? WHERE orchestration_id = ? AND id = ? AND status IN ('queued', 'pending_gate')",
    )
    .run(now, orchId, stepId)
}

/** Holds a queued step (the lead asked for `ask_owner`, or admission found the agent below its floor). */
export function holdStep(
  ctx: Ctx,
  o: OrchRow,
  step: Pick<StepRow, 'id' | 'agent_id'>,
  below: BelowFloor,
  opts: { tellLead: boolean },
): void {
  const { sqlite, now } = ctx
  writeHold(sqlite, o.id, step.id, step.agent_id, below, 'held', now)
  markHeld(sqlite, o.id, step.id, now)
  addHistory(
    sqlite,
    o.id,
    'quota_held',
    {
      stepId: step.id,
      agentId: step.agent_id,
      window: below.window,
      group: below.group,
      leftPercent: below.leftPercent,
      resetsAt: below.resetsAt,
    },
    now,
  )
  // The lead can re-plan around a step that was already queued (cancel it, or assign the work to another agent).
  if (opts.tellLead && o.planner === 'lead')
    addCause(sqlite, o.id, 'step_held', step.id, now, heldSentence(step.id, step.agent_id, below))
  touch(ctx, o.id)
}

/**
 * The admission gate for one queued step: `true` means it may be admitted now. A step whose agent is below its floor is
 * held (once, with a cause for the lead); a hold whose condition is gone is released; a step the person answered "Use it
 * anyway" for goes through; one the person chose to wait for goes through when its window has reset and a fresh check
 * passes. Never touches a running step.
 */
export function quotaAdmits(
  ctx: Ctx,
  source: QuotaSource | undefined,
  o: OrchRow,
  step: Pick<StepRow, 'id' | 'agent_id' | 'disposition'>,
): boolean {
  const { sqlite, now } = ctx
  const hold = holdOf(sqlite, o.id, step.id)
  if (hold?.state === 'override') return true
  const below = quotaCheck(sqlite, source, o, step.agent_id, Date.parse(now))
  if (below === null) {
    if (hold) {
      sqlite
        .prepare('DELETE FROM orc_quota_holds WHERE orchestration_id = ? AND step_id = ?')
        .run(o.id, step.id)
      setStepStatus(sqlite, o.id, step.id, 'queued', null, now)
      addHistory(
        sqlite,
        o.id,
        hold.state === 'waiting' ? 'quota_waited' : 'quota_released',
        { stepId: step.id, agentId: step.agent_id },
        now,
      )
      touch(ctx, o.id)
    }
    return true
  }
  if (!hold) {
    holdStep(ctx, o, step, below, { tellLead: true })
    return false
  }
  // The person chose to wait: the step stays quiet until the window it waits for has reset.
  if (hold.state === 'waiting' && Date.parse(now) < Date.parse(hold.resets_at)) return false
  // Still low after the wait (or low again): ask again with the numbers as they are now.
  const changed =
    hold.state !== 'held' ||
    hold.window !== below.window ||
    hold.resets_at !== below.resetsAt ||
    hold.left_percent !== below.leftPercent
  if (changed) {
    writeHold(sqlite, o.id, step.id, step.agent_id, below, 'held', hold.created_at)
    touch(ctx, o.id)
  }
  if (hold.state !== 'held')
    addHistory(
      sqlite,
      o.id,
      'quota_held',
      {
        stepId: step.id,
        agentId: step.agent_id,
        window: below.window,
        leftPercent: below.leftPercent,
        resetsAt: below.resetsAt,
      },
      now,
    )
  if (step.disposition !== 'quota_low') markHeld(sqlite, o.id, step.id, now)
  return false
}
