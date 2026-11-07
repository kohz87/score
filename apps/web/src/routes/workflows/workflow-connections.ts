import { WORKFLOW_LIMITS, type WorkflowEdge } from '@score/contract'
import { nextEdgeId } from './workflow-model-ids.ts'
import { portsOf, type Draft } from './workflow-model-types.ts'
import { updateNode } from './workflow-nodes.ts'

type ConnectResult = { draft: Draft } | { error: string }

/** Connect `from`'s `port` to `to`. Fan-out is allowed; a duplicate, a self-loop and an edge out of an end are not. */
export function connect(draft: Draft, from: string, port: string, to: string): ConnectResult {
  const source = draft.nodes.find((node) => node.id === from)
  const target = draft.nodes.find((node) => node.id === to)
  if (!source || !target) return { error: 'Both ends of a connection must exist.' }
  if (source.kind === 'end') return { error: 'An end has nothing after it.' }
  if (!portsOf(source).some((p) => p.id === port))
    return { error: `${source.label} has no "${port}" connection.` }
  if (from === to) return { error: 'A step can’t lead back to itself.' }
  if (draft.edges.some((e) => e.from === from && e.port === port && e.to === to))
    return { error: 'Those two are already connected that way.' }
  if (draft.edges.length >= WORKFLOW_LIMITS.maxEdges)
    return { error: `A workflow can have at most ${WORKFLOW_LIMITS.maxEdges} connections.` }
  let next: Draft = {
    ...draft,
    edges: [...draft.edges, { id: nextEdgeId(draft), from, port, to }],
  }
  // A failure or rejection edge means "route it": the choice stays explicit, the editor only keeps it consistent.
  if (source.kind === 'agent' && port === 'failed' && source.onFailure !== 'route')
    next = updateNode(next, from, { onFailure: 'route' })
  if (source.kind === 'gate' && port === 'rejected' && source.onReject !== 'route')
    next = updateNode(next, from, { onReject: 'route' })
  return { draft: next }
}

export function disconnect(draft: Draft, edgeId: string): Draft {
  return { ...draft, edges: draft.edges.filter((edge) => edge.id !== edgeId) }
}

export function edgesFrom(draft: Draft, nodeId: string): WorkflowEdge[] {
  return draft.edges.filter((edge) => edge.from === nodeId)
}
export function edgesTo(draft: Draft, nodeId: string): WorkflowEdge[] {
  return draft.edges.filter((edge) => edge.to === nodeId)
}

/** Every node that can reach `nodeId` along the edges (templates may only read from these). */
export function ancestorsOf(draft: Pick<Draft, 'edges'>, nodeId: string): Set<string> {
  const found = new Set<string>()
  const stack = [nodeId]
  while (stack.length > 0) {
    const current = stack.pop()!
    for (const edge of draft.edges) {
      if (edge.to === current && !found.has(edge.from)) {
        found.add(edge.from)
        stack.push(edge.from)
      }
    }
  }
  found.delete(nodeId)
  return found
}
