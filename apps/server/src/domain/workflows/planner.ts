import type { Ctx } from '../orchestration/ctx.ts'
import { admissionRevision } from '../orchestration/ops.ts'
import { readOrch, type OrchRow } from '../orchestration/store.ts'
import { assign } from './planner-assign.ts'
import { defOf, isFinalNode, load } from './planner-context.ts'
import { maybeFinish } from './planner-finish.ts'
import { agentAncestors, openNodeGate, resolve } from './planner-graph.ts'
import { observe } from './planner-observe.ts'
import { nodesOf, requireWfRun, setNode } from './store.ts'

// ----------------------------------------------------------------------------------------------------- entry point

/**
 * One planning pass for a workflow run. Idempotent: running it again on unchanged state does nothing. Returns whether
 * anything changed.
 */
export function planWorkflow(ctx: Ctx, o: OrchRow): boolean {
  const { sqlite } = ctx
  let any = false
  // v8.1 item 2: a run whose admission revision is behind re-evaluates its waiting work with a new generation.
  const revision = admissionRevision(sqlite)
  if (o.admission_seen < revision) {
    const waiting = nodesOf(sqlite, o.id).some((n) => n.state === 'ready')
    if (waiting)
      sqlite
        .prepare(
          'UPDATE wf_runs SET planner_generation = planner_generation + 1 WHERE orchestration_id = ?',
        )
        .run(o.id)
    sqlite.prepare('UPDATE orchestrations SET admission_seen = ? WHERE id = ?').run(revision, o.id)
    any = true
  }
  for (let round = 0; round < 80; round++) {
    const current = readOrch(sqlite, o.id)
    if (!current) return any
    const p = load(ctx, current)
    if (
      current.status === 'stopping' ||
      current.status === 'finishing' ||
      ['succeeded', 'failed', 'stopped', 'finished_with_unresolved'].includes(current.status)
    ) {
      // Nothing new is issued; observed results are still recorded.
      if (!observe(p)) break
      any = true
      continue
    }
    let progressed = observe(p)
    progressed = resolve(p) || progressed
    if (p.canIssue) {
      for (const node of p.nodes.values()) {
        if (node.state !== 'ready') continue
        const def = defOf(p, node.node_id)
        if (def.kind === 'gate') {
          // A gate is shown only evidence that stands: wait while a result it would display is unresolved.
          if (
            agentAncestors(p, node.node_id).some(
              (id) => !['succeeded', 'failed'].includes(p.nodes.get(id)!.state),
            )
          )
            continue
          openNodeGate(p, node)
          progressed = true
        } else if (def.kind === 'agent') progressed = assign(p, node) || progressed
      }
      if (!progressed) progressed = maybeFinish(p)
    }
    if (!progressed) break
    any = true
  }
  return any
}

/** At the run's end: the graph's own outcome and any node that never resolved. */
export function finalizeGraph(ctx: Ctx, orchId: string, status: string): void {
  const { sqlite, now } = ctx
  const wf = requireWfRun(sqlite, orchId)
  if (wf.graph_outcome === null)
    sqlite
      .prepare('UPDATE wf_runs SET graph_outcome = ? WHERE orchestration_id = ?')
      .run(status === 'stopped' ? 'stopped' : 'failed', orchId)
  for (const node of nodesOf(sqlite, orchId))
    if (!isFinalNode(node.state) && node.state !== 'unresolved')
      setNode(sqlite, orchId, node.node_id, {
        state: 'cancelled',
        reason: 'the run ended',
        ended_at: now,
      })
  sqlite
    .prepare(
      "UPDATE wf_gates SET status = 'withdrawn', revision = revision + 1, decided_at = ? WHERE orchestration_id = ? AND status = 'open'",
    )
    .run(now, orchId)
}

export { assignWait } from './planner-assign.ts'
export { startEdge } from './planner-context.ts'
