import type { RemapPlanItem } from '@score/contract'
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { attemptsOf, stepsOf, type AttemptRow, type OrchRow } from '../orchestration/store.ts'
import { journalDispatches, type ExecutionJournal } from '../orchestration/journal.ts'
import { renderAgentPayload } from './payload.ts'
import { nodesOf, type WfRunRow } from './store.ts'
const hash = (text: string): string => createHash('sha256').update(text).digest('hex')

// ------------------------------------------------------------------------------------------------ remap plan

/**
 * What a remap of `agentId` would do to work that was never sent (v8.1 item 1): the exact payloads that will be
 * dispatched, so the decision can approve them. Possibly-sent work is not listed; it keeps its attempt.
 */
export function remapPlan(
  sqlite: DatabaseSync,
  o: OrchRow,
  wf: WfRunRow,
  agentId: string,
  journal: ExecutionJournal | undefined,
): { nodeIds: string[]; items: (RemapPlanItem & { stepId: string | null })[] } {
  const nodes = nodesOf(sqlite, o.id)
  const byId = new Map(nodes.map((n) => [n.node_id, n]))
  const steps = new Map(stepsOf(sqlite, o.id).map((s) => [s.id, s]))
  const attempts = attemptsOf(sqlite, o.id)
  const sent = journal?.readOwn()
  const dispatches = sent?.ok ? journalDispatches(sent.entries) : undefined
  const items: (RemapPlanItem & { stepId: string | null })[] = []
  const nodeIds: string[] = []
  for (const def of wf.definition.nodes) {
    if (def.kind !== 'agent' || def.agentId !== agentId) continue
    const node = byId.get(def.id)
    if (!node || !['ready', 'gate_open', 'running'].includes(node.state)) continue
    const step = node.step_id ? steps.get(node.step_id) : undefined
    if (step && !['pending_gate', 'queued', 'admitted', 'blocked'].includes(step.status)) continue
    const attempt = step
      ? attempts
          .filter((a) => a.step_id === step.id)
          .reduce<AttemptRow | undefined>((b, a) => (!b || a.n > b.n ? a : b), undefined)
      : undefined
    // Provably unsent: no attempt yet, one refused before it was sent, or a `created` one that neither the database nor
    // the journal ever recorded as sent. An unreadable journal proves nothing, so that work counts as possibly sent.
    const unsent =
      !attempt ||
      attempt.state === 'refused' ||
      (attempt.state === 'created' &&
        dispatches !== undefined &&
        dispatches.get(attempt.id)?.state !== 'sent')
    if (!unsent) continue
    const rendered = renderAgentPayload({
      runId: o.id,
      nodeId: def.id,
      def: wf.definition,
      inputs: wf.inputs,
      nodes: byId,
    })
    if (!rendered.ok) continue
    nodeIds.push(def.id)
    items.push({
      nodeId: def.id,
      stepId: step?.status === 'blocked' ? null : (step?.id ?? null),
      retiresAttemptId: attempt?.id ?? null,
      payloadHash: hash(rendered.text),
      payload: rendered.text,
    })
  }
  return { nodeIds, items }
}
