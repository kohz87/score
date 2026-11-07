import type { WorkflowEvent } from '@score/contract'
import type { DatabaseSync } from 'node:sqlite'
import { redact } from '../../redact.ts'
import type { OrchRow } from '../orchestration/store.ts'

// ------------------------------------------------------------------------------------------------------- events

/** Derived on read from the persisted rows: nothing is invented client-side. */
export function workflowEventsOf(sqlite: DatabaseSync, o: OrchRow): WorkflowEvent[] {
  const events: WorkflowEvent[] = []
  const rows = sqlite
    .prepare('SELECT id, kind, detail, at FROM orc_history WHERE orchestration_id = ? ORDER BY id')
    .all(o.id) as { id: number; kind: string; detail: string; at: string }[]
  const kindOf: Record<string, WorkflowEvent['kind']> = {
    wf_node: 'node_state',
    wf_token: 'token',
    wf_failed: 'planner',
    created: 'run_started',
    ended: 'control',
    paused: 'control',
    resumed: 'control',
    stop_requested: 'control',
    finish_requested: 'graph_end',
    limits_changed: 'control',
    abandoned: 'control',
    waiver: 'control',
    agent_remapped: 'control',
    node_retried: 'planner',
    node_try_again: 'planner',
    gate_approved: 'gate_decided',
    gate_rejected: 'gate_decided',
    wf_gate_decided: 'gate_decided',
  }
  for (const row of rows) {
    const kind = kindOf[row.kind]
    if (!kind) continue
    const detail = JSON.parse(row.detail) as Record<string, unknown>
    const nodeId = typeof detail.nodeId === 'string' ? detail.nodeId : null
    events.push({
      id: `h${row.id}`,
      at: row.at,
      kind,
      stepId: typeof detail.stepId === 'string' ? detail.stepId : null,
      attemptId: typeof detail.attemptId === 'string' ? detail.attemptId : null,
      tool: null,
      verdict: typeof detail.state === 'string' ? detail.state : null,
      code: null,
      summary: redact(
        row.kind === 'wf_node'
          ? `${nodeId}: ${String(detail.state)}${detail.reason ? ` (${String(detail.reason)})` : ''}`
          : row.kind === 'wf_token'
            ? `token ${String(detail.kind)} on ${String(detail.edgeId)}`
            : row.kind.replaceAll('_', ' '),
      ).slice(0, 300),
      nodeId,
      edgeId: row.kind === 'wf_token' && typeof detail.edgeId === 'string' ? detail.edgeId : null,
    })
  }
  return events
}
