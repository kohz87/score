import type { WorkflowDefinition, WorkflowEdge, WorkflowNode } from '@score/contract'
import { portsOf } from '../routes/workflows/workflow-model.ts'
import type { RecipeAnalysis, RecipeProblem, RecipeRoute } from './recipe-model-types.ts'

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
function shortCondition(node: WorkflowNode, port: string): string {
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

function routeLabel(node: WorkflowNode, port: string): string {
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
