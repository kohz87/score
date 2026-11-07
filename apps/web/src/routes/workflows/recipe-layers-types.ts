import type { WorkflowNodeKind } from '@score/contract'
import type { NodeVisual } from '../orchestrations/orch-model.ts'

export interface CardState {
  visual: NodeVisual
  /** What the step's agent is doing now, while it runs. */
  status?: string
}

export type InsertAt = { edgeId: string } | { before: string } | { after: string }
export type InsertStep = (
  at: InsertAt,
  kind: WorkflowNodeKind,
  agentId: string,
  agentName: string,
) => void
