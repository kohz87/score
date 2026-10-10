import { touch, type Ctx } from '../orchestration/ctx.ts'
import { journalDispatches } from '../orchestration/journal.ts'
import { refuseAttempt, setStepStatus } from '../orchestration/ops.ts'
import { addCause, addHistory, attemptsOf, readOrch, stepsOf } from '../orchestration/store.ts'
import { nodesOf, setNode, wfGatesOf } from './store.ts'

/**
 * A node's result was withdrawn (its attempt is no longer a confirmed success). Everything that rested on it stops, the
 * way fix J does for orchestrations: consumers that were never sent are retired with `input_withdrawn` and their gates
 * withdrawn; local gates that display the result are withdrawn and their node waits to be shown the evidence again.
 * Possibly-sent consumers keep their obligations. Idempotent.
 */
export function withdrawGraphEvidence(ctx: Ctx, orchId: string, nodeId: string, why: string): void {
  const { sqlite, now } = ctx
  const o = readOrch(sqlite, orchId)
  if (!o) return
  sqlite
    .prepare('UPDATE wf_consumed SET withdrawn = 1 WHERE orchestration_id = ? AND producer = ?')
    .run(orchId, nodeId)
  const read = ctx.journal.readOwn()
  const dispatches = read.ok ? journalDispatches(read.entries) : undefined
  const steps = new Map(stepsOf(sqlite, orchId).map((s) => [s.id, s]))
  const attempts = attemptsOf(sqlite, orchId)
  const consumers = sqlite
    .prepare('SELECT DISTINCT step_id FROM wf_consumed WHERE orchestration_id = ? AND producer = ?')
    .all(orchId, nodeId) as { step_id: string }[]
  for (const { step_id } of consumers) {
    const step = steps.get(step_id)
    if (!step || !['pending_gate', 'queued', 'admitted'].includes(step.status)) continue
    const latest = attempts
      .filter((a) => a.step_id === step.id)
      .reduce<(typeof attempts)[number] | undefined>((b, a) => (!b || a.n > b.n ? a : b), undefined)
    // Without a readable journal nothing is provably unsent.
    const unsent =
      !latest ||
      (latest.state === 'created' &&
        dispatches !== undefined &&
        dispatches.get(latest.id)?.state !== 'sent')
    if (!unsent) continue
    if (latest) {
      refuseAttempt(sqlite, latest, `input_withdrawn: ${nodeId} ${why}`, now)
      sqlite
        .prepare("UPDATE orc_attempts SET input = '[input withdrawn]' WHERE id = ?")
        .run(latest.id)
    }
    sqlite
      .prepare(
        "UPDATE orc_gates SET status = 'withdrawn', revision = revision + 1, decided_at = ? WHERE orchestration_id = ? AND step_id = ? AND status IN ('open', 'approved')",
      )
      .run(now, orchId, step.id)
    setStepStatus(sqlite, orchId, step.id, 'blocked', `input_withdrawn: ${nodeId} ${why}`, now)
    addCause(sqlite, orchId, 'step_blocked', step.id, now, 'input_withdrawn')
  }
  const byId = new Map(nodesOf(sqlite, orchId).map((n) => [n.node_id, n]))
  for (const gate of wfGatesOf(sqlite, orchId)) {
    if (gate.status !== 'open') continue
    const shown = (JSON.parse(gate.payload) as { consumed: { nodeId: string }[] }).consumed
    if (!shown.some((c) => c.nodeId === nodeId)) continue
    sqlite
      .prepare(
        "UPDATE wf_gates SET status = 'withdrawn', revision = revision + 1, decided_at = ? WHERE orchestration_id = ? AND id = ?",
      )
      .run(now, orchId, gate.id)
    if (byId.get(gate.node_id)?.state === 'gate_open')
      setNode(sqlite, orchId, gate.node_id, {
        state: 'ready',
        gate_id: null,
        reason: `${nodeId}'s result was withdrawn`,
      })
    addHistory(
      sqlite,
      orchId,
      'wf_gate_decided',
      { gateId: gate.id, nodeId: gate.node_id, state: 'withdrawn' },
      now,
    )
  }
  touch(ctx, orchId)
}
