import type { WorkflowNode } from '@score/contract'
import type { Draft } from '../routes/workflows/workflow-model.ts'

export function reorderNodes(definition: Draft, order: readonly WorkflowNode[]): Draft {
  const byId = new Map(definition.nodes.map((node) => [node.id, node]))
  const nodes = order.flatMap((node) => {
    const found = byId.get(node.id)
    return found ? [found] : []
  })
  for (const node of definition.nodes) if (!nodes.includes(node)) nodes.push(node)
  return { ...definition, nodes }
}
