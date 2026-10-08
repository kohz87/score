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
export function applyLifecycle(sqlite: DatabaseSync, agent: AgentDetail): AgentDetail {
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
    throw new HttpError(409, 'conflict', 'Agent is not ready for new work')
}
