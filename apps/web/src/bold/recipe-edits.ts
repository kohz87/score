import { WORKFLOW_LIMITS, type WorkflowNode, type WorkflowNodeKind } from '@score/contract'
import {
  blankNode,
  nextEdgeId,
  portsOf,
  removeNode,
  updateNode,
  type Draft,
} from '../routes/workflows/workflow-model.ts'
import { orderNodes } from './recipe-analysis.ts'
import { reorderNodes } from './recipe-reorder.ts'

/** Point a port at one step (or nowhere). One target per port is what the list shows; fan-out stays graph-only. */
export function setPortTarget(
  draft: Draft,
  nodeId: string,
  port: string,
  targetId: string | null,
): Draft {
  const node = draft.nodes.find((item) => item.id === nodeId)
  if (!node || targetId === nodeId) return draft
  if (targetId !== null && !draft.nodes.some((item) => item.id === targetId)) return draft
  if (!portsOf(node).some((item) => item.id === port)) return draft
  const existing = draft.edges.filter((edge) => edge.from === nodeId && edge.port === port)
  const keepId = existing[0]?.id ?? null
  let next: Draft = {
    ...draft,
    edges: draft.edges.filter((edge) => !(edge.from === nodeId && edge.port === port)),
  }
  if (targetId !== null) {
    next = {
      ...next,
      edges: [...next.edges, { id: keepId ?? nextEdgeId(next), from: nodeId, port, to: targetId }],
    }
  }
  if (node.kind === 'agent' && port === 'failed' && targetId !== null && node.onFailure !== 'route')
    next = updateNode(next, nodeId, { onFailure: 'route' })
  if (node.kind === 'gate' && port === 'rejected' && targetId !== null && node.onReject !== 'route')
    next = updateNode(next, nodeId, { onReject: 'route' })
  return next
}

export function setFailureMode(draft: Draft, nodeId: string, mode: 'route' | 'fail_run'): Draft {
  const node = draft.nodes.find((item) => item.id === nodeId)
  if (node?.kind !== 'agent') return draft
  let next = updateNode(draft, nodeId, { onFailure: mode })
  if (mode === 'fail_run')
    next = {
      ...next,
      edges: next.edges.filter((edge) => !(edge.from === nodeId && edge.port === 'failed')),
    }
  return next
}

export function setRejectMode(draft: Draft, nodeId: string, mode: 'route' | 'stop_run'): Draft {
  const node = draft.nodes.find((item) => item.id === nodeId)
  if (node?.kind !== 'gate') return draft
  let next = updateNode(draft, nodeId, { onReject: mode })
  if (mode === 'stop_run')
    next = {
      ...next,
      edges: next.edges.filter((edge) => !(edge.from === nodeId && edge.port === 'rejected')),
    }
  return next
}

function freePort(node: WorkflowNode, draft: Draft): string | null {
  const preferred = ['ok', 'default']
  const ports = portsOf(node).filter((port) => !['failed', 'rejected'].includes(port.id))
  const ordered = [
    ...preferred.flatMap((id) => ports.filter((port) => port.id === id)),
    ...ports.filter((port) => !preferred.includes(port.id)),
  ]
  for (const port of ordered)
    if (!draft.edges.some((edge) => edge.from === node.id && edge.port === port.id)) return port.id
  return null
}

/**
 * Add a step: before the final End when there is one, and into a straight run when the insertion point has one.
 * A step that needs a target the chain can't supply is left for the person to point with the row's target selects.
 */
export function addRecipeStep(
  draft: Draft,
  kind: WorkflowNodeKind,
  agentId = '',
): { draft: Draft; id: string } | { error: string } {
  if (draft.nodes.length >= WORKFLOW_LIMITS.maxNodes)
    return { error: `A recipe can have at most ${WORKFLOW_LIMITS.maxNodes} steps.` }
  const order = orderNodes(draft)
  const lastIsEnd = order.at(-1)?.kind === 'end'
  const insertAt = kind !== 'end' && lastIsEnd ? order.length - 1 : order.length
  const node = blankNode(draft, kind, agentId)
  let next: Draft = { ...draft, nodes: [...draft.nodes, node] }
  const previous = order[insertAt - 1]
  const following = order[insertAt]
  if (kind === 'branch') {
    // A branch checks the nearest earlier agent, even when the step immediately before it is a gate.
    const subject = order
      .slice(0, insertAt)
      .reverse()
      .find((step) => step.kind === 'agent')
    if (subject) next = updateNode(next, node.id, { subject: subject.id })
  }
  if (kind === 'join' && following) {
    // A join inserted before a step that several paths already lead into waits for all of them, not just the last one.
    const incoming = next.edges.filter((edge) => edge.to === following.id)
    if (incoming.length >= 2) {
      const incomingIds = new Set(incoming.map((edge) => edge.id))
      const outgoingId = nextEdgeId(next)
      next = {
        ...next,
        edges: [
          ...next.edges.filter((edge) => !incomingIds.has(edge.id)),
          ...incoming.map((edge) => ({ ...edge, to: node.id })),
          { id: outgoingId, from: node.id, port: 'ok', to: following.id },
        ],
      }
    }
  }
  if (previous && following) {
    const links = next.edges.filter((edge) => edge.from === previous.id && edge.to === following.id)
    // A branch has several routes and no `ok`; insert into "otherwise" so the new step follows the usual path.
    const link =
      previous.kind === 'branch'
        ? (links.find((edge) => edge.port === 'default') ?? links[0])
        : links.find((edge) => edge.port === 'ok')
    if (link) {
      const splitPort = link.port
      const outgoingPort = portsOf(node)[0]?.id
      // Allocate while the split edge is still in the draft, so the new edge cannot reuse its id.
      const outgoing =
        kind === 'end' || !outgoingPort
          ? []
          : [
              {
                id: nextEdgeId(next),
                from: node.id,
                port: outgoingPort,
                to: following.id,
              },
            ]
      next = {
        ...next,
        edges: [
          ...next.edges.filter((edge) => edge.id !== link.id),
          { id: link.id, from: previous.id, port: splitPort, to: node.id },
          ...outgoing,
        ],
      }
    }
  }
  if (!next.edges.some((edge) => edge.to === node.id)) {
    if (previous) {
      const port = freePort(previous, next)
      if (port)
        next = {
          ...next,
          edges: [...next.edges, { id: nextEdgeId(next), from: previous.id, port, to: node.id }],
        }
    } else if (following && kind !== 'end') {
      const outgoingPort = portsOf(node)[0]?.id
      if (!outgoingPort) return { draft: reorderNodes(next, orderNodes(next)), id: node.id }
      next = {
        ...next,
        edges: [
          ...next.edges,
          { id: nextEdgeId(next), from: node.id, port: outgoingPort, to: following.id },
        ],
      }
    }
  }
  // A new branch shows both of its routes in the list straight away: every rule and the default lead to the step it
  // was inserted before until the person points one somewhere else.
  if (kind === 'branch' && following) {
    for (const port of portsOf(node)) {
      if (next.edges.some((edge) => edge.from === node.id && edge.port === port.id)) continue
      next = {
        ...next,
        edges: [
          ...next.edges,
          { id: nextEdgeId(next), from: node.id, port: port.id, to: following.id },
        ],
      }
    }
  }
  // A branch has no single `ok` edge to split. Once the new step is on one of its paths, keep the list's reading
  // order by continuing into the step it was inserted before (when that step offers a free normal route).
  if (following && kind !== 'end' && !next.edges.some((edge) => edge.from === node.id)) {
    const port = freePort(node, next)
    if (port)
      next = {
        ...next,
        edges: [...next.edges, { id: nextEdgeId(next), from: node.id, port, to: following.id }],
      }
  }
  return { draft: reorderNodes(next, orderNodes(next)), id: node.id }
}

/** Remove a step; a straight run closes over it, so the step after takes its place. */
export function removeRecipeStep(draft: Draft, nodeId: string): Draft {
  const order = orderNodes(draft)
  const index = order.findIndex((node) => node.id === nodeId)
  if (index === -1) return draft
  const previous = order[index - 1]
  const following = order[index + 1]
  let next = draft
  if (previous && following) {
    const inEdge = draft.edges.find(
      (edge) => edge.from === previous.id && edge.port === 'ok' && edge.to === nodeId,
    )
    const outEdge = draft.edges.find(
      (edge) => edge.from === nodeId && edge.port === 'ok' && edge.to === following.id,
    )
    const already = draft.edges.some(
      (edge) => edge.from === previous.id && edge.port === 'ok' && edge.to === following.id,
    )
    if (inEdge && outEdge && !already) {
      next = {
        ...draft,
        edges: [
          ...draft.edges.filter((edge) => edge.id !== inEdge.id && edge.id !== outEdge.id),
          { id: inEdge.id, from: previous.id, port: 'ok', to: following.id },
        ],
      }
    }
  }
  const removed = removeNode(next, nodeId)
  return reorderNodes(removed, orderNodes(removed))
}
