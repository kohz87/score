import { WORKFLOW_LIMITS, type WorkflowNodeKind } from '@score/contract'
import { connect } from './workflow-connections.ts'
import { nextEdgeId } from './workflow-model-ids.ts'
import { portsOf, type Draft } from './workflow-model-types.ts'
import { addNode, forwardPort, updateNode } from './workflow-nodes.ts'

type AddResult = { draft: Draft; id: string; note: string } | { error: string }

/** A new node with its agent's name as the label; the draft is not changed. */
function newStep(draft: Draft, kind: WorkflowNodeKind, agentId: string, agentName?: string) {
  const result = addNode(draft, kind, agentId)
  if ('error' in result) return result
  const draft2 =
    kind === 'agent' && agentName
      ? updateNode(result.draft, result.id, { label: `${agentName} step` })
      : result.draft
  const said = kind === 'agent' && agentName ? `${agentName} step` : kind
  return { draft: draft2, id: result.id, said }
}

/**
 * A step connected after `after`: on the first way out of it that leads nowhere yet (never a failure or rejection
 * route). Without `after`, or after an end, the step is added unconnected.
 */
export function addStepAfter(
  draft: Draft,
  after: string | null,
  kind: WorkflowNodeKind,
  agentId = '',
  agentName?: string,
): AddResult {
  // A step whose only way on is already connected (the usual case in a finished recipe) gets the new step between it and
  // what it led to, rather than a step floating beside the recipe.
  const from = after ? draft.nodes.find((node) => node.id === after) : undefined
  if (from && from.kind !== 'end' && kind !== 'end') {
    const ways = portsOf(from).filter((port) => port.id !== 'failed' && port.id !== 'rejected')
    const used = draft.edges.filter((edge) => edge.from === from.id && edge.port === ways[0]?.id)
    if (ways.length === 1 && used.length === 1)
      return insertStepOnEdge(draft, used[0]!.id, kind, agentId, agentName)
    // A way on that already fans out to several steps gets one more path, when the connection limit allows.
    if (ways.length === 1 && used.length >= 2) {
      const made = newStep(draft, kind, agentId, agentName)
      if ('error' in made) return made
      const joined = connect(made.draft, from.id, ways[0]!.id, made.id)
      if ('draft' in joined) {
        let next = joined.draft
        if (kind === 'branch' && from.kind === 'agent')
          next = updateNode(next, made.id, { subject: from.id })
        return {
          draft: next,
          id: made.id,
          note: `Added ${made.said} as one more path after ${from.label}.`,
        }
      }
    }
  }
  const made = newStep(draft, kind, agentId, agentName)
  if ('error' in made) return made
  let next = made.draft
  let note = `Added ${made.said}.`
  const source = after ? next.nodes.find((node) => node.id === after) : undefined
  if (source && source.kind !== 'end') {
    const free = portsOf(source).find(
      (port) =>
        port.id !== 'failed' &&
        port.id !== 'rejected' &&
        !next.edges.some((edge) => edge.from === source.id && edge.port === port.id),
    )
    if (free) {
      const joined = connect(next, source.id, free.id, made.id)
      if ('draft' in joined) {
        next = joined.draft
        note = `${note} Connected after ${source.label}.`
      }
    }
    if (!next.edges.some((edge) => edge.to === made.id))
      note = `Added ${made.said}, not connected yet: connect it in its settings.`
    if (kind === 'branch' && source.kind === 'agent')
      next = updateNode(next, made.id, { subject: source.id })
  }
  return { draft: next, id: made.id, note }
}

/** A step in the middle of a connection: A (port) to B becomes A (port) to the new step, and the new step to B. */
export function insertStepOnEdge(
  draft: Draft,
  edgeId: string,
  kind: WorkflowNodeKind,
  agentId = '',
  agentName?: string,
): AddResult {
  const edge = draft.edges.find((item) => item.id === edgeId)
  if (!edge) return { error: 'That connection is gone.' }
  if (kind === 'end') return { error: 'An end can’t sit between two steps.' }
  const made = newStep(draft, kind, agentId, agentName)
  if ('error' in made) return made
  const created = made.draft.nodes.find((node) => node.id === made.id)!
  const port = forwardPort(created)
  if (!port) return { error: 'That step has no way on.' }
  if (made.draft.edges.length >= WORKFLOW_LIMITS.maxEdges)
    return { error: `A workflow can have at most ${WORKFLOW_LIMITS.maxEdges} connections.` }
  const from = made.draft.nodes.find((node) => node.id === edge.from)
  // A branch leads on from its first rule and from "otherwise", so a new branch doesn't leave a way out dangling.
  const wayOn = created.kind === 'branch' ? [port, 'default'] : [port]
  if (made.draft.edges.length + wayOn.length > WORKFLOW_LIMITS.maxEdges)
    return { error: `A workflow can have at most ${WORKFLOW_LIMITS.maxEdges} connections.` }
  const along: Draft['edges'] = []
  for (const way of wayOn)
    along.push({
      id: nextEdgeId({ edges: [...made.draft.edges, ...along] }),
      from: made.id,
      port: way,
      to: edge.to,
    })
  let next: Draft = {
    ...made.draft,
    edges: [
      ...made.draft.edges.map((item) => (item.id === edge.id ? { ...item, to: made.id } : item)),
      ...along,
    ],
  }
  if (kind === 'branch' && from?.kind === 'agent')
    next = updateNode(next, made.id, { subject: from.id })
  const to = draft.nodes.find((node) => node.id === edge.to)?.label ?? edge.to
  return { draft: next, id: made.id, note: `Added ${made.said} before ${to}.` }
}

/** A new first step: it leads to `before`, which was a first step itself. */
export function insertStepBefore(
  draft: Draft,
  before: string,
  kind: WorkflowNodeKind,
  agentId = '',
  agentName?: string,
): AddResult {
  const target = draft.nodes.find((node) => node.id === before)
  if (!target) return { error: 'That step is gone.' }
  if (kind === 'end') return { error: 'An end can’t come first.' }
  const made = newStep(draft, kind, agentId, agentName)
  if ('error' in made) return made
  const created = made.draft.nodes.find((node) => node.id === made.id)!
  const port = forwardPort(created)
  if (!port) return { error: 'That step has no way on.' }
  let joined = connect(made.draft, made.id, port, before)
  if ('error' in joined) return joined
  if (created.kind === 'branch') {
    joined = connect(joined.draft, made.id, 'default', before)
    if ('error' in joined) return joined
  }
  return {
    draft: joined.draft,
    id: made.id,
    note: `Added ${made.said} before ${target.label}.`,
  }
}
