import {
  WORKFLOW_LIMITS,
  type WorkflowDefinition,
  type WorkflowEdge,
  type WorkflowNode,
  type WorkflowNodeKind,
} from '@score/contract'
import {
  ancestorsOf,
  blankNode,
  nextEdgeId,
  portsOf,
  removeNode,
  updateNode,
  type Draft,
} from '../routes/workflows/workflow-model.ts'

// The step-list view of a workflow definition (PLAN 11.10d). A recipe IS a 7.1 workflow: this module only derives a
// friendly ordering and per-port targets from the same graph, and writes edits back into that graph. Nothing here
// validates the graph: the server's validation is the authority, and the editor shows its answer beside the
// prototype's own client-side problems.

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

/** A stable topological order: Kahn's algorithm, choosing the earliest stored node among the ready ones. */
function orderNodes(definition: Pick<WorkflowDefinition, 'nodes' | 'edges'>): WorkflowNode[] {
  const byId = new Map(definition.nodes.map((node) => [node.id, node]))
  const stored = new Map(definition.nodes.map((node, index) => [node.id, index]))
  const indegree = new Map(definition.nodes.map((node) => [node.id, 0]))
  const outgoing = new Map<string, WorkflowEdge[]>()
  for (const edge of definition.edges) {
    if (!byId.has(edge.from) || !byId.has(edge.to)) continue
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1)
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge])
  }
  const ready = definition.nodes
    .filter((node) => indegree.get(node.id) === 0)
    .map((node) => node.id)
  const order: WorkflowNode[] = []
  while (ready.length > 0) {
    const id = ready.shift()!
    order.push(byId.get(id)!)
    for (const edge of outgoing.get(id) ?? []) {
      const left = (indegree.get(edge.to) ?? 0) - 1
      indegree.set(edge.to, left)
      if (left !== 0) continue
      // The ready queue is kept in stored order, so equally ready nodes follow the definition's own order.
      const at = ready.findIndex((other) => (stored.get(other) ?? 0) > (stored.get(edge.to) ?? 0))
      if (at === -1) ready.push(edge.to)
      else ready.splice(at, 0, edge.to)
    }
  }
  // A cycle (which validation refuses) still shows every node rather than hiding the rest.
  for (const node of definition.nodes)
    if (!order.some((item) => item.id === node.id)) order.push(node)
  return order
}

function hasCycle(definition: Pick<WorkflowDefinition, 'nodes' | 'edges'>): boolean {
  const ids = new Set(definition.nodes.map((node) => node.id))
  const indegree = new Map([...ids].map((id) => [id, 0]))
  const outgoing = new Map<string, string[]>()
  for (const edge of definition.edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) continue
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1)
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to])
  }
  const ready = [...ids].filter((id) => indegree.get(id) === 0)
  const seen = new Set<string>()
  while (ready.length > 0) {
    const id = ready.shift()!
    seen.add(id)
    for (const next of outgoing.get(id) ?? []) {
      const left = (indegree.get(next) ?? 0) - 1
      indegree.set(next, left)
      if (left === 0) ready.push(next)
    }
  }
  return seen.size < ids.size
}

/** "passed", "changes requested", "succeeded", "failed", `contains "…"`: the short words the step list uses. */
export function shortCondition(node: WorkflowNode, port: string): string {
  if (node.kind !== 'branch') return port
  if (port === 'default') return 'otherwise'
  const rule = node.rules.find((item) => item.id === port)
  if (!rule) return port
  switch (rule.when.kind) {
    case 'verdict':
      return rule.when.is === 'passed' ? 'passed' : 'changes requested'
    case 'outcome':
      return rule.when.is === 'succeeded' ? 'succeeded' : 'failed'
    case 'output_contains':
      return `contains “${rule.when.text}”`
  }
}

export function routeLabel(node: WorkflowNode, port: string): string {
  const known = portsOf(node).find((item) => item.id === port)
  if (node.kind === 'branch') return shortCondition(node, port)
  return known?.label ?? port
}

export function analyzeRecipe(definition: WorkflowDefinition): RecipeAnalysis {
  const order = orderNodes(definition)
  const graphOnlyReasons: string[] = []
  const nodeIds = definition.nodes.map((node) => node.id)
  const byId = new Map(definition.nodes.map((node) => [node.id, node]))
  if (new Set(nodeIds).size !== nodeIds.length)
    graphOnlyReasons.push('The recipe uses the same step id twice.')
  for (const edge of definition.edges) {
    const from = byId.get(edge.from)
    const to = byId.get(edge.to)
    if (!from || !to) {
      graphOnlyReasons.push(`Edge ${edge.id} points at a step that is not in this recipe.`)
    } else if (!portsOf(from).some((port) => port.id === edge.port)) {
      graphOnlyReasons.push(
        `${from.label || from.id} sends “${edge.port}”, which is not one of its routes.`,
      )
    }
  }
  if (hasCycle(definition)) graphOnlyReasons.push('The recipe contains a loop.')
  const rows = order.map((node, index) => {
    const incoming = definition.edges.filter((edge) => edge.to === node.id)
    const routes: RecipeRoute[] = portsOf(node).map((port) => {
      const edges = definition.edges.filter(
        (edge) => edge.from === node.id && edge.port === port.id,
      )
      return {
        port: port.id,
        label: routeLabel(node, port.id),
        edges,
        targets: edges.map((edge) => edge.to),
      }
    })
    // Shape-only definitions can hold an edge whose port the node doesn't offer; show it rather than hide it.
    const unknownPorts = definition.edges
      .filter((edge) => edge.from === node.id && !routes.some((route) => route.port === edge.port))
      .map((edge) => edge.port)
    for (const port of [...new Set(unknownPorts)]) {
      const edges = definition.edges.filter((edge) => edge.from === node.id && edge.port === port)
      routes.push({ port, label: port, edges, targets: edges.map((edge) => edge.to) })
    }
    for (const route of routes) {
      if (route.edges.length > 1)
        graphOnlyReasons.push(
          `${node.label || node.id} sends “${route.label}” to ${route.edges.length} steps at once.`,
        )
    }
    return { node, index, incoming, routes }
  })
  return {
    order,
    rows,
    listable: graphOnlyReasons.length === 0,
    graphOnlyReasons: [...new Set(graphOnlyReasons)],
  }
}

/** The prototype's own checks, in the same words and step numbers. The server adds the graph rules. */
export function recipeClientProblems(
  definition: Pick<WorkflowDefinition, 'nodes' | 'edges'>,
  order: readonly WorkflowNode[] = orderNodes(definition),
): RecipeProblem[] {
  if (definition.nodes.length === 0)
    return [{ code: 'empty', message: 'Add at least one step.', nodeId: null }]
  const problems: RecipeProblem[] = []
  order.forEach((node, index) => {
    if (node.kind === 'agent' && (!node.agentId || !node.instruction.trim()))
      problems.push({
        code: 'agent_incomplete',
        message: `Step ${index + 1} needs an agent and an instruction.`,
        nodeId: node.id,
      })
    if (node.kind === 'gate' && index === order.length - 1)
      problems.push({
        code: 'gate_last',
        message: `Step ${index + 1}: a gate needs a step after it.`,
        nodeId: node.id,
      })
    if (node.kind === 'branch' && !node.subject)
      problems.push({
        code: 'branch_subject',
        message: `Step ${index + 1}: a branch needs a step to check.`,
        nodeId: node.id,
      })
  })
  const last = order.at(-1)
  if (last && last.kind !== 'end')
    problems.push({
      code: 'no_end',
      message: 'The last step should be an End.',
      nodeId: last.id,
    })
  return problems
}

export function targetStepLabel(
  analysis: Pick<RecipeAnalysis, 'order'>,
  id: string,
): string | null {
  const index = analysis.order.findIndex((node) => node.id === id)
  if (index === -1) return null
  const node = analysis.order[index]!
  return `Step ${index + 1} · ${node.label || node.id}`
}

function reorderNodes(definition: Draft, order: readonly WorkflowNode[]): Draft {
  const byId = new Map(definition.nodes.map((node) => [node.id, node]))
  const nodes = order.flatMap((node) => {
    const found = byId.get(node.id)
    return found ? [found] : []
  })
  for (const node of definition.nodes) if (!nodes.includes(node)) nodes.push(node)
  return { ...definition, nodes }
}

/** One edge from `from`'s normal output to `to`, and nothing else leads into `to`. */
function normalLink(
  definition: Pick<Draft, 'nodes' | 'edges'>,
  from: WorkflowNode,
  to: WorkflowNode,
): WorkflowEdge | undefined {
  if (from.kind !== 'agent' && from.kind !== 'gate') return undefined
  if (to.kind !== 'agent' && to.kind !== 'gate') return undefined
  const outgoing = definition.edges.filter((edge) => edge.from === from.id && edge.port === 'ok')
  if (outgoing.length !== 1 || outgoing[0]!.to !== to.id) return undefined
  const incoming = definition.edges.filter((edge) => edge.to === to.id)
  if (incoming.length !== 1) return undefined
  return outgoing[0]
}

function orderIds(nodes: readonly WorkflowNode[]): string {
  return nodes.map((node) => node.id).join('\0')
}

function edgeIds(definition: Pick<Draft, 'edges'>): string {
  return definition.edges
    .map((edge) => edge.id)
    .sort()
    .join('\0')
}

function rootCount(definition: Pick<Draft, 'nodes' | 'edges'>): number {
  const incoming = new Set(definition.edges.map((edge) => edge.to))
  return definition.nodes.filter((node) => !incoming.has(node.id)).length
}

function hasDuplicateEdges(definition: Pick<Draft, 'edges'>): boolean {
  const ids = new Set<string>()
  const links = new Set<string>()
  for (const edge of definition.edges) {
    if (ids.has(edge.id)) return true
    ids.add(edge.id)
    const link = `${edge.from}\0${edge.port}\0${edge.to}`
    if (links.has(link)) return true
    links.add(link)
  }
  return false
}

const NODE_REFERENCE = /\{\{\s*nodes\.([a-z][a-z0-9_-]*)/g

function referencesIn(text: string): string[] {
  return [...text.matchAll(NODE_REFERENCE)].map((match) => match[1]!)
}

/** Moving a step may reorder its run, but it must not silently break a template read or a branch's subject. */
function ancestryPreserved(before: Draft, after: Draft): boolean {
  for (const node of before.nodes) {
    const text =
      node.kind === 'agent' ? node.instruction : node.kind === 'gate' ? node.question : ''
    if (text !== '') {
      const was = ancestorsOf(before, node.id)
      const now = ancestorsOf(after, node.id)
      for (const reference of referencesIn(text))
        if (was.has(reference) !== now.has(reference)) return false
    }
    if (node.kind === 'branch' && node.subject !== '') {
      const was = ancestorsOf(before, node.id)
      const now = ancestorsOf(after, node.id)
      if (was.has(node.subject) !== now.has(node.subject)) return false
    }
  }
  return true
}

function clientAnswer(definition: Draft, order: readonly WorkflowNode[]): string {
  return recipeClientProblems(definition, order)
    .map((problem) => `${problem.code}/${problem.nodeId ?? ''}/${problem.message}`)
    .sort()
    .join('\0')
}

/**
 * Reorder a straight agent/gate run. Every edge into its old first step now comes into the new first step, and the
 * run's `ok` continuation leaves its new last step, so no upstream route is left behind or lost.
 */
function rewriteStraightRun(
  draft: Draft,
  order: readonly WorkflowNode[],
  from: number,
  to: number,
): Draft | null {
  const nextOrder = [...order]
  ;[nextOrder[from], nextOrder[to]] = [nextOrder[to]!, nextOrder[from]!]

  // The straight run around the swap, made only of agent and gate steps.
  let left = Math.min(from, to)
  let right = Math.max(from, to)
  while (left > 0 && normalLink(draft, order[left - 1]!, order[left]!)) left--
  while (right < order.length - 1 && normalLink(draft, order[right]!, order[right + 1]!)) right++
  const run = order.slice(left, right + 1)
  const nextRun = nextOrder.slice(left, right + 1)
  if (run.length < 2) return null
  const internal: WorkflowEdge[] = []
  for (let index = 0; index < run.length - 1; index++) {
    const edge = normalLink(draft, run[index]!, run[index + 1]!)
    if (!edge) return null
    internal.push(edge)
  }
  // A run may not hold a different edge between its own steps (a failure path, say).
  const internalIds = new Set(internal.map((edge) => edge.id))
  const runIds = new Set(run.map((node) => node.id))
  if (
    draft.edges.some(
      (edge) => runIds.has(edge.from) && runIds.has(edge.to) && !internalIds.has(edge.id),
    )
  )
    return null

  const oldFirst = run[0]!
  const oldLast = run.at(-1)!
  const newFirst = nextRun[0]!
  const newLast = nextRun.at(-1)!
  const outsideIn = draft.edges.filter((edge) => edge.to === oldFirst.id && !runIds.has(edge.from))
  const outsideOut = draft.edges.filter(
    (edge) => edge.from === oldLast.id && edge.port === 'ok' && !runIds.has(edge.to),
  )
  // A port with more than one target is graph-only; never flatten that into a different graph here.
  if (outsideOut.length > 1) return null
  const outsideInIds = new Set(outsideIn.map((edge) => edge.id))
  const outsideOutIds = new Set(outsideOut.map((edge) => edge.id))
  const edges = draft.edges
    .filter((edge) => !internalIds.has(edge.id))
    .map((edge) => {
      if (outsideInIds.has(edge.id)) return { ...edge, to: newFirst.id }
      if (outsideOutIds.has(edge.id)) return { ...edge, from: newLast.id }
      return edge
    })
  return reorderNodes(
    {
      ...draft,
      edges: [
        ...edges,
        ...internal.map((edge, index) => ({
          ...edge,
          from: nextRun[index]!.id,
          to: nextRun[index + 1]!.id,
          port: 'ok',
        })),
      ],
    },
    nextOrder,
  )
}

/**
 * Plan one step move. A move is either a stored-order swap of nodes that are already free to trade places, or a
 * relink of one straight run. Unsafe moves are refused with words the row can show.
 */
export function planRecipeMove(draft: Draft, nodeId: string, direction: -1 | 1): RecipeMovePlan {
  const analysis = analyzeRecipe(draft)
  const order = analysis.order
  const from = order.findIndex((node) => node.id === nodeId)
  const to = from + direction
  const unchanged = { draft, order, changed: false }
  if (from === -1) return { ...unchanged, reason: 'That step is not in this recipe.' }
  if (to < 0) return { ...unchanged, reason: 'It is already the first step.' }
  if (to >= order.length) return { ...unchanged, reason: 'It is already the last step.' }
  if (!analysis.listable)
    return {
      ...unchanged,
      reason: 'Only a recipe the step list can show can be reordered.',
    }
  const nextOrder = [...order]
  ;[nextOrder[from], nextOrder[to]] = [nextOrder[to]!, nextOrder[from]!]
  const desired = orderIds(nextOrder)

  const onlyReordered = reorderNodes(draft, nextOrder)
  const candidate =
    orderIds(orderNodes(onlyReordered)) === desired
      ? onlyReordered
      : rewriteStraightRun(draft, order, from, to)
  if (candidate === null)
    // The stored order alone cannot make these two steps trade places, and there is no straight run to relink.
    return {
      ...unchanged,
      reason: 'This move would not change the visible order of the steps.',
    }
  if (orderIds(orderNodes(candidate)) !== desired)
    return {
      ...unchanged,
      reason: 'This move would not change the visible order of the steps.',
    }
  const after = analyzeRecipe(candidate)
  if (!after.listable)
    return {
      ...unchanged,
      reason: 'This move would turn the recipe into one only the graph editor can show.',
    }
  if (clientAnswer(draft, order) !== clientAnswer(candidate, after.order))
    return {
      ...unchanged,
      reason: 'This move would leave the recipe with different steps to fix.',
    }
  if (
    edgeIds(candidate) !== edgeIds(draft) ||
    candidate.edges.length !== draft.edges.length ||
    hasDuplicateEdges(candidate) ||
    rootCount(candidate) !== rootCount(draft) ||
    !ancestryPreserved(draft, candidate)
  )
    return {
      ...unchanged,
      reason: 'This move would break how the steps connect. Use the graph editor for this one.',
    }
  return { draft: candidate, order: after.order, changed: true, reason: null }
}

/** The disabled-arrow reason for a move, or null when the arrow can work. */
export function moveRecipeStepProblem(
  draft: Draft,
  nodeId: string,
  direction: -1 | 1,
): string | null {
  return planRecipeMove(draft, nodeId, direction).reason
}

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
