import type { WorkflowNodeKind } from '@score/contract'
import { edgesFrom } from './workflow-connections.ts'
import { portLabel, type Draft } from './workflow-model-types.ts'

interface OutlineItem {
  id: string
  title: string
  kind: WorkflowNodeKind
  /** "when done goes to Review", one per connection. */
  connections: { edgeId: string; port: string; text: string; to: string }[]
  /** Nothing leads into it. */
  root: boolean
}

/** The text equivalent of the canvas: every node in reading order with where each of its ports leads. */
export function outlineOf(draft: Draft): OutlineItem[] {
  const byId = new Map(draft.nodes.map((n) => [n.id, n]))
  const indegree = new Map(draft.nodes.map((n) => [n.id, 0]))
  for (const edge of draft.edges)
    if (indegree.has(edge.to) && byId.has(edge.from))
      indegree.set(edge.to, indegree.get(edge.to)! + 1)
  // Kahn order, stable on the order the nodes were added; a cycle's remainder follows in that order.
  const remaining = new Map(indegree)
  const order: string[] = []
  const queue = draft.nodes.filter((n) => remaining.get(n.id) === 0).map((n) => n.id)
  while (queue.length > 0) {
    const id = queue.shift()!
    order.push(id)
    for (const edge of draft.edges) {
      if (edge.from !== id || !remaining.has(edge.to)) continue
      remaining.set(edge.to, remaining.get(edge.to)! - 1)
      if (remaining.get(edge.to) === 0) queue.push(edge.to)
    }
  }
  for (const node of draft.nodes) if (!order.includes(node.id)) order.push(node.id)
  return order.map((id) => {
    const node = byId.get(id)!
    return {
      id,
      title: node.label,
      kind: node.kind,
      root: indegree.get(id) === 0,
      connections: edgesFrom(draft, id).map((edge) => ({
        edgeId: edge.id,
        port: edge.port,
        to: edge.to,
        text: `${portLabel(node, edge.port)} goes to ${byId.get(edge.to)?.label ?? edge.to}`,
      })),
    }
  })
}
