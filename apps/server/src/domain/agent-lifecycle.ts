import { AgentSummarySchema, type AgentDetail } from '@score/contract'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { HttpError } from '../errors.ts'

const Row = z.object({
  agent_id: z.string(),
  incarnation_id: z.uuid(),
  state: AgentSummarySchema.shape.lifecycle.unwrap().shape.state,
  operation_id: z.uuid().nullable(),
  display_name: z.string().nullable(),
})
export function lifecycleOf(sqlite: DatabaseSync, id: string) {
  const row = sqlite.prepare('SELECT * FROM agent_lifecycle WHERE agent_id = ?').get(id)
  return row ? Row.parse(row) : null
}
export function agentPausedAt(sqlite: DatabaseSync, id: string): string | null {
  const row = sqlite.prepare('SELECT paused_at FROM agent_pauses WHERE agent_id = ?').get(id)
  return row ? z.object({ paused_at: z.string() }).parse(row).paused_at : null
}
// "Pause <agent>" shows as the paused status until Resume, even while the agent is offline (the hold is durable and
// Resume must stay reachable); a half-set-up or removed agent keeps its own status.
export function applyLifecycle(sqlite: DatabaseSync, agent: AgentDetail): AgentDetail {
  const next = applyLifecycleRow(sqlite, agent)
  if (
    (next.lifecycle && next.lifecycle.state !== 'ready') ||
    agentPausedAt(sqlite, agent.id) === null
  )
    return next
  return { ...next, status: 'paused', activity: 'Paused' }
}
function applyLifecycleRow(sqlite: DatabaseSync, agent: AgentDetail): AgentDetail {
  const row = lifecycleOf(sqlite, agent.id)
  if (!row) return agent
  const ready = row.state === 'ready'
  return {
    ...agent,
    name: row.display_name ?? agent.name,
    lifecycle: {
      state: row.state,
      incarnationId: row.incarnation_id,
      operationId: row.operation_id,
    },
    ...(!ready
      ? ({
          served: false,
          status: 'offline',
          activity: {
            setting_up: 'Setting up',
            deleting: 'Deleting',
            needs_attention: 'Needs attention',
            removed: 'Removed',
            ready: null,
          }[row.state],
        } as const)
      : {}),
  }
}
export function agentAdmits(sqlite: DatabaseSync, id: string): boolean {
  const row = lifecycleOf(sqlite, id)
  return !row || row.state === 'ready'
}
export function assertAgentAdmits(sqlite: DatabaseSync, id: string): void {
  if (!agentAdmits(sqlite, id))
    throw new HttpError(
      409,
      'conflict',
      'This agent isn’t ready for new work yet. Wait a moment and try again.',
    )
}
