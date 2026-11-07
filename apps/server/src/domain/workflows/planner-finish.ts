import { beginFinish } from '../orchestration/ops.ts'
import { hashOf, isFinalNode, type Pass } from './planner-context.ts'
import { commandsOf, wfGatesOf } from './store.ts'

// -------------------------------------------------------------------------------------------------- terminal graph

export function maybeFinish(p: Pass): boolean {
  const { sqlite, now } = p.ctx
  if (!p.canIssue) return false
  const nodes = [...p.nodes.values()]
  if (!nodes.every((n) => isFinalNode(n.state))) return false
  if (
    [...p.steps.values()].some((s) =>
      ['pending_gate', 'queued', 'admitted', 'unknown'].includes(s.status),
    )
  )
    return false
  if (p.attempts.some((a) => ['created', 'send_started', 'running'].includes(a.state))) return false
  if (wfGatesOf(sqlite, p.o.id).some((g) => g.status === 'open')) return false
  if ([...p.tokens.values()].some((t) => t.consumed_by === null)) return false
  const generation = p.wf.planner_generation
  const hasReceipt = commandsOf(sqlite, p.o.id).some((c) => c.verb === 'finish')
  const reachedEnd = nodes.some((n) => n.kind === 'end' && n.state === 'succeeded')
  const failed = !reachedEnd
  if (!hasReceipt)
    sqlite
      .prepare(
        `INSERT INTO wf_commands (orchestration_id, node_id, attempt, verb, generation, payload_hash, receipt, outcome, created_at)
         VALUES (?, '__run', 0, 'finish', ?, ?, ?, 'ok', ?)`,
      )
      .run(
        p.o.id,
        generation,
        hashOf(failed ? 'failed' : 'success'),
        JSON.stringify({ status: 'ok' }),
        now,
      )
  sqlite
    .prepare('UPDATE wf_runs SET graph_outcome = ?, graph_reason = ? WHERE orchestration_id = ?')
    .run(failed ? 'failed' : 'reached_end', failed ? 'no end was reached' : null, p.o.id)
  beginFinish(
    p.ctx,
    p.o,
    null,
    failed ? 'failed' : 'success',
    failed ? 'The graph ended without reaching an end.' : 'The graph reached its end.',
  )
  return true
}
