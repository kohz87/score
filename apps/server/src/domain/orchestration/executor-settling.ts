import { closeRunJobs } from '../exchanges/job-life.ts'
import { touch, type Ctx } from './ctx.ts'
import { stopRun } from './decisions.ts'
import { bumpAdmission, cascadeBlocked } from './ops.ts'
import { finalizeGraph, planWorkflow } from '../workflows/planner.ts'
import { nodesOf, requireWfRun } from '../workflows/store.ts'
import { settleHelpers } from './helpers.ts'
import { checkPending } from './checks.ts'
import {
  addHistory,
  attemptsOf,
  causesAfter,
  gatesOf,
  inquiriesOf,
  isTerminalStatus,
  listOrchs,
  readOrch,
  stepsOf,
  type OrchRow,
} from './store.ts'

import type { OrchestratorRuntime } from './executor-runtime.ts'

export const settlingMethods = {
  // ----------------------------------------------------------------------------------------------------- settling

  /** Per-run housekeeping done after every transaction that touched the run. Returns whether the status changed. */
  settle(this: OrchestratorRuntime, ctx: Ctx, orchId: string): boolean {
    const { sqlite, now } = ctx
    let o = readOrch(sqlite, orchId)
    if (!o || isTerminalStatus(o.status)) return false
    cascadeBlocked(sqlite, orchId, now)
    // 3.15–3.16: a finished scan starts the lead; a vote whose answers have ended is tallied.
    settleHelpers(ctx, o)
    // A workflow run's planner is its graph: it runs inside the transaction of whatever woke the run.
    if (o.planner === 'workflow') {
      const planned = planWorkflow(ctx, o)
      o = readOrch(sqlite, orchId) ?? o
      if (planned && o.status !== 'running') touch(ctx, orchId)
    }
    const attempts = attemptsOf(sqlite, orchId)
    // A suspended attempt (agent changed, limit reached) holds no slot and does not keep the run alive.
    const live = attempts.some(
      (a) => !a.suspended && ['created', 'send_started', 'running'].includes(a.state),
    )
    const end = (status: OrchRow['status'], reason: string | null): boolean => {
      sqlite
        .prepare(
          'UPDATE orchestrations SET status = ?, pause_reason = NULL, ended_at = ?, end_reason = ? WHERE id = ?',
        )
        .run(status, now, reason, orchId)
      addHistory(sqlite, orchId, 'ended', { status, reason }, now)
      // 3.28.0: the run was its chat job; the job closes with it, so the chat can start its next one.
      ctx.events.push(...closeRunJobs(sqlite, orchId, now))
      // Capacity and reservations of this run are released: waiting work elsewhere may be admissible now.
      bumpAdmission(sqlite)
      if (o!.planner === 'workflow') finalizeGraph(ctx, orchId, status)
      return true
    }
    // The deadline is a fence-and-drain: admission stops, queued work is retired, owed Stops go to every admitted attempt.
    if (
      (o.status === 'running' || o.status === 'paused') &&
      o.deadline_at !== null &&
      now >= o.deadline_at
    ) {
      stopRun(ctx, orchId, 'deadline')
      return true
    }
    if (o.status === 'stopping') {
      const unresolved = attempts.some((a) => a.state === 'unknown' && a.abandoned_at === null)
      if (live || unresolved) return false
      // An unrouted failure is a fence-and-drain too, but its run ends `failed`, not `stopped`.
      const failedGraph =
        o.planner === 'workflow' && requireWfRun(sqlite, orchId).graph_outcome === 'failed'
      return failedGraph
        ? end('failed', o.end_reason ?? 'the graph failed')
        : end('stopped', o.end_reason ?? 'stopped by the person')
    }
    if (o.status === 'finishing') {
      if (live) return false
      if (attempts.some((a) => ['unknown', 'abandoned'].includes(a.state)))
        return end('finished_with_unresolved', 'attempts not confirmed ended')
      return o.finish_outcome === 'failed'
        ? end('failed', 'the lead finished with outcome failed')
        : end('succeeded', null)
    }
    if (o.status !== 'running') return false
    const steps = stepsOf(sqlite, orchId)
    const wakeSource =
      live ||
      (o.planner === 'workflow' &&
        nodesOf(sqlite, orchId).some((n) =>
          ['ready', 'gate_open', 'running', 'unresolved'].includes(n.state),
        )) ||
      (o.planner === 'lead' && causesAfter(sqlite, orchId, o.causes_consumed_up_to).length > 0) ||
      // A check queued or running ends with a cause that wakes the lead (3.13).
      checkPending(sqlite, orchId) ||
      steps.some((s) => ['pending_gate', 'queued', 'admitted'].includes(s.status)) ||
      inquiriesOf(sqlite, orchId).some((q) => q.status === 'open') ||
      gatesOf(sqlite, orchId).some((g) => g.status === 'open') ||
      attempts.some((a) => a.state === 'unknown' && a.abandoned_at === null) ||
      // A coding step blocked with its suspended attempt waits for the person (settings, limit): that is on Needs you, not
      // a run nobody can wake (7.7b §12a).
      attempts.some((a) => a.suspended && a.state === 'created')
    if (!wakeSource) {
      this.pauseFor(ctx, o, 'no_wake_source')
      return true
    }
    return false
  },

  /** The periodic pass: touches every live run so deadlines and quiescence are noticed without any event. */
  sweep(this: OrchestratorRuntime, ctx: Ctx): void {
    for (const o of listOrchs(ctx.sqlite)) if (!isTerminalStatus(o.status)) touch(ctx, o.id)
  },

  // ---------------------------------------------------------------------------------------------------- admission

  pauseFor(this: OrchestratorRuntime, ctx: Ctx, o: OrchRow, reason: string): void {
    // A manual hold is never overwritten by a condition.
    if (o.manual_paused_at !== null) return
    ctx.sqlite
      .prepare("UPDATE orchestrations SET status = 'paused', pause_reason = ? WHERE id = ?")
      .run(reason, o.id)
    addHistory(ctx.sqlite, o.id, 'paused', { reason }, ctx.now)
    touch(ctx, o.id)
  },
}

export type SettlingMethods = typeof settlingMethods
