import {
  WORKFLOW_LIMITS,
  type WorkflowDefinition,
  type WorkflowEdge,
  type WorkflowNode,
  type WorkflowNodeKind,
} from '@score/contract'
import {
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

export interface RecipeProblem {
  code: string
  message: string
  nodeId: string | null
}

/** A stable topological order: Kahn's algorithm, choosing the earliest stored node among the ready ones. */
export function orderNodes(
  definition: Pick<WorkflowDefinition, 'nodes' | 'edges'>,
): WorkflowNode[] {
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

/**
 * Move one step up or down. The nodes are stored in the new order, and a straight run of agent/gate steps has its
 * normal (`ok`) edges relinked so the run keeps meaning "one after another". Branches, joins and ends keep their routes.
 */
export function moveRecipeStep(draft: Draft, nodeId: string, direction: -1 | 1): Draft {
  const order = orderNodes(draft)
  const from = order.findIndex((node) => node.id === nodeId)
  const to = from + direction
  if (from === -1 || to < 0 || to >= order.length) return draft
  const nextOrder = [...order]
  ;[nextOrder[from], nextOrder[to]] = [nextOrder[to]!, nextOrder[from]!]

  // The straight run around the swap, made only of agent and gate steps.
  let left = Math.min(from, to)
  let right = Math.max(from, to)
  while (left > 0 && normalLink(draft, order[left - 1]!, order[left]!)) left--
  while (right < order.length - 1 && normalLink(draft, order[right]!, order[right + 1]!)) right++
  const run = order.slice(left, right + 1)
  const nextRun = nextOrder.slice(left, right + 1)
  let edges = draft.edges
  if (run.length > 1) {
    const internal: WorkflowEdge[] = []
    for (let index = 0; index < run.length - 1; index++) {
      const edge = normalLink(draft, run[index]!, run[index + 1]!)
      if (!edge) return reorderNodes(draft, nextOrder)
      internal.push(edge)
    }
    // A run may not hold a different edge between its own steps (a failure path, say): leave it untouched then.
    const internalIds = new Set(internal.map((edge) => edge.id))
    const runIds = new Set(run.map((node) => node.id))
    if (
      draft.edges.some(
        (edge) => runIds.has(edge.from) && runIds.has(edge.to) && !internalIds.has(edge.id),
      )
    )
      return reorderNodes(draft, nextOrder)

    const oldFirst = run[0]!
    const oldLast = run.at(-1)!
    const newFirst = nextRun[0]!
    const newLast = nextRun.at(-1)!
    const outsideIn = draft.edges.filter((edge) => edge.to === oldFirst.id)
    const outsideOut = draft.edges.filter((edge) => edge.from === oldLast.id && edge.port === 'ok')
    const retargetIn =
      outsideIn.length === 1 && !runIds.has(outsideIn[0]!.from) && outsideIn[0]!.port === 'ok'
        ? outsideIn[0]!
        : undefined
    const retargetOut =
      outsideOut.length === 1 && !runIds.has(outsideOut[0]!.to) ? outsideOut[0]! : undefined

    edges = draft.edges
      .filter((edge) => !internalIds.has(edge.id))
      .map((edge) => {
        if (retargetIn && edge.id === retargetIn.id && newFirst.id !== oldFirst.id)
          return { ...edge, to: newFirst.id }
        if (retargetOut && edge.id === retargetOut.id && newLast.id !== oldLast.id)
          return { ...edge, from: newLast.id }
        return edge
      })
    edges = [
      ...edges,
      ...internal.map((edge, index) => ({
        ...edge,
        from: nextRun[index]!.id,
        to: nextRun[index + 1]!.id,
        port: 'ok',
      })),
    ]
  }
  return reorderNodes({ ...draft, edges }, nextOrder)
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
  if (kind === 'branch' && previous?.kind === 'agent')
    next = updateNode(next, node.id, { subject: previous.id })
  if (previous && following) {
    const link = next.edges.find(
      (edge) => edge.from === previous.id && edge.port === 'ok' && edge.to === following.id,
    )
    if (link) {
      const outgoingPort = portsOf(node)[0]?.id
      next = { ...next, edges: next.edges.filter((edge) => edge.id !== link.id) }
      next = {
        ...next,
        edges: [
          ...next.edges,
          { id: link.id, from: previous.id, port: 'ok', to: node.id },
          ...(kind === 'end' || !outgoingPort
            ? []
            : [
                {
                  id: nextEdgeId(next),
                  from: node.id,
                  port: outgoingPort,
                  to: following.id,
                },
              ]),
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
