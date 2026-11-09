import { allowMoreSubagents } from '../subagents.ts'
import { runJobScope } from './subagent-scope.ts'
import type { LimitsDecision } from '@score/contract'
import type { DatabaseSync } from 'node:sqlite'
import { HttpError } from '../../errors.ts'
import { journalSoft, touch, type Ctx } from './ctx.ts'
import { expectRevision } from './decision-guards.ts'
import { resumeSuspendedSteps } from './decision-quota.ts'
import { effectiveSize } from './helpers.ts'
import { bumpAdmission, codingItemBytesOf, codingItemsFor, codingUnsentBytes } from './ops.ts'
import { addHistory, isTerminalStatus, requireOrch } from './store.ts'

export function setLimits(
  ctx: Ctx,
  orchId: string,
  body: LimitsDecision,
  storageFits: (sqlite: DatabaseSync, extraBytes: number) => boolean = () => true,
): void {
  const { sqlite, now } = ctx
  const o = requireOrch(sqlite, orchId)
  expectRevision(o, body.orchestrationRevision)
  if (isTerminalStatus(o.status)) throw new HttpError(409, 'conflict', `This run is ${o.status}.`)
  if (body.deadlineAt !== undefined && body.deadlineAt !== null && body.deadlineAt <= now)
    throw new HttpError(400, 'bad_request', 'The deadline must be in the future.')
  // A workflow without coding agents has no coding settings to change (7.7c §1).
  if (
    o.planner === 'workflow' &&
    (body.codingSteps !== undefined ||
      body.acceptUnknownCost !== undefined ||
      body.quotaFloorPercent !== undefined) &&
    sqlite
      .prepare('SELECT 1 FROM orc_worker_policies WHERE orchestration_id = ? LIMIT 1')
      .get(orchId) === undefined
  )
    throw new HttpError(
      400,
      'bad_request',
      'This workflow has no coding agents, so it takes no coding settings.',
    )
  if (body.budgetUsd !== undefined)
    sqlite
      .prepare('UPDATE orchestrations SET budget_usd = ? WHERE id = ?')
      .run(body.budgetUsd, orchId)
  // 8.6: the quota floor. Admission judges every held step again against the new floor (a lower one lets it go on).
  if (body.quotaFloorPercent !== undefined)
    sqlite
      .prepare('UPDATE orchestrations SET quota_floor_percent = ? WHERE id = ?')
      .run(body.quotaFloorPercent, orchId)
  if (body.deadlineAt !== undefined)
    sqlite
      .prepare('UPDATE orchestrations SET deadline_at = ? WHERE id = ?')
      .run(body.deadlineAt, orchId)
  if (body.moreSubagents !== undefined) {
    const jobId = runJobScope(sqlite, orchId).jobId
    if (jobId) ctx.events.push(...allowMoreSubagents(sqlite, jobId, body.moreSubagents))
  }
  if (body.acceptUnknownSpend !== undefined)
    sqlite
      .prepare('UPDATE orchestrations SET accepted_unknown_spend = ? WHERE id = ?')
      .run(body.acceptUnknownSpend ? 1 : 0, orchId)
  if (body.acceptUnknownCost !== undefined) {
    const accepted = new Set(o.accepted_unknown_cost)
    for (const source of body.acceptUnknownCost.add ?? []) accepted.add(source)
    for (const source of body.acceptUnknownCost.remove ?? []) accepted.delete(source)
    sqlite
      .prepare('UPDATE orchestrations SET accepted_unknown_cost = ? WHERE id = ?')
      .run(JSON.stringify([...accepted].sort()), orchId)
  }
  if (body.codingSteps !== undefined) {
    // Each coding item the limit now allows holds its own inventory in the run's reserve. A higher limit grows the reserve
    // (a lower one keeps it), or is refused when the database has no storage for the growth (F1 #7).
    const hasWorkers =
      sqlite
        .prepare('SELECT 1 FROM orc_worker_policies WHERE orchestration_id = ? LIMIT 1')
        .get(orchId) !== undefined
    // Growth is measured against what is already reserved, not against the previous limit: 10 -> 4 -> 10 keeps ten
    // items' reserve and adds nothing (F2 #5). An item is the PLANNER's: a workflow's holds more than an orchestration's.
    const itemBytes = codingItemBytesOf(o.planner)
    // The unsent-inventory room is part of the partition but not an item: it stays out of the item count (F1 #6).
    // Sized as at creation: the lead's steps plus its helpers' and the advisor's (3.14–3.16 review).
    const size = effectiveSize(o)
    const unsent = hasWorkers ? codingUnsentBytes(size.steps, size.concurrent) : 0
    const reservedItems = Math.floor(Math.max(0, o.coding_reserve_bytes - unsent) / itemBytes)
    const grow = hasWorkers
      ? Math.max(0, codingItemsFor(size.steps, body.codingSteps) - reservedItems) * itemBytes
      : 0
    if (grow > 0 && !storageFits(sqlite, grow))
      throw new HttpError(
        409,
        'quota_exhausted',
        'Score has no storage left for more coding steps in this run.',
      )
    if (grow > 0)
      sqlite
        .prepare(
          'UPDATE orchestrations SET reserve_bytes = reserve_bytes + ?, coding_reserve_bytes = coding_reserve_bytes + ? WHERE id = ?',
        )
        .run(grow, grow, orchId)
    sqlite
      .prepare('UPDATE orchestrations SET coding_steps = ? WHERE id = ?')
      .run(body.codingSteps, orchId)
    // Raising the limit lets the steps it blocked go on: the same suspended attempt is admitted again (7.7b §12a).
    if (body.codingSteps > o.coding_steps) resumeSuspendedSteps(ctx, orchId, 'coding_limit')
  }
  // A pause caused by a limit ends with the decision about that limit; admission re-pauses if it still applies.
  if (
    o.status === 'paused' &&
    ['budget', 'unknown_spend', 'deadline', 'subagent_total'].includes(o.pause_reason ?? '')
  )
    // The condition is gone; a manual hold that is still there keeps the run paused, now for its own reason.
    sqlite
      .prepare(
        o.manual_paused_at !== null
          ? "UPDATE orchestrations SET pause_reason = 'person' WHERE id = ?"
          : "UPDATE orchestrations SET status = 'running', pause_reason = NULL WHERE id = ?",
      )
      .run(orchId)
  addHistory(sqlite, orchId, 'limits_changed', { ...body, orchestrationRevision: undefined }, now)
  bumpAdmission(sqlite)
  // Every change is journaled as the full resulting state, so a database that lost a tightening is detected at start.
  const after = requireOrch(sqlite, orchId)
  journalSoft(ctx, () =>
    ctx.journal.append({
      kind: 'authorization',
      orchestrationId: orchId,
      budgetUsd: after.budget_usd,
      deadlineAt: after.deadline_at,
      acceptUnknownSpend: after.accepted_unknown_spend,
      codingSteps: after.coding_steps,
      acceptUnknownCost: after.accepted_unknown_cost,
    }),
  )
  touch(ctx, orchId)
}
