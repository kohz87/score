import type { WorkflowRunDetail } from '@score/contract'
import type { WorkflowRunActions } from './workflow-queries.ts'

export type Actions = WorkflowRunActions

export const labelOf = (run: Pick<WorkflowRunDetail, 'definition'>, nodeId: string): string =>
  run.definition.nodes.find((node) => node.id === nodeId)?.label ?? nodeId
