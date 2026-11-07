import type { WorkflowEdge, WorkflowNode } from '@score/contract'
import { ancestorsOf, type Draft } from '../routes/workflows/workflow-model.ts'
import { analyzeRecipe, orderNodes, recipeClientProblems } from './recipe-analysis.ts'
import type { RecipeMovePlan } from './recipe-model-types.ts'
import { reorderNodes } from './recipe-reorder.ts'

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
