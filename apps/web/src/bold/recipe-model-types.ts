import type { WorkflowEdge, WorkflowNode, WorkflowNodeKind } from '@score/contract'
import type { Draft } from '../routes/workflows/workflow-model.ts'

export const RECIPE_STEP_LABEL: Record<WorkflowNodeKind, string> = {
  agent: 'Agent step',
  gate: 'Gate · waits for your OK',
  branch: 'Branch',
  join: 'Join · waits for all',
  end: 'End',
}

export const RECIPE_STEP_MARK: Record<Exclude<WorkflowNodeKind, 'agent'>, string> = {
  gate: '◆',
  branch: '⬡',
  join: '⋈',
  end: '■',
}

export interface RecipeRoute {
  port: string
  /** What the person reads: "when done", "passed", "otherwise". */
  label: string
  /** The graph's edges out of this port in stored order; more than one is fan-out. */
  edges: WorkflowEdge[]
  targets: string[]
}

export interface RecipeRow {
  node: WorkflowNode
  index: number
  incoming: WorkflowEdge[]
  routes: RecipeRoute[]
}

export interface RecipeAnalysis {
  /** Topological, ties broken by the stored node order. */
  order: WorkflowNode[]
  rows: RecipeRow[]
  /** False when a port leaves for more than one step: a list can't show that faithfully. */
  listable: boolean
  graphOnlyReasons: string[]
}

export interface RecipeMovePlan {
  draft: Draft
  /** The order the list shows after the move. */
  order: WorkflowNode[]
  changed: boolean
  /** Why the move is disabled; null when it can happen. */
  reason: string | null
}

export interface RecipeProblem {
  code: string
  message: string
  nodeId: string | null
}
