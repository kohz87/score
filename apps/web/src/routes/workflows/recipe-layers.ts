import type { WorkflowNode } from '@score/contract'
import { describeCondition, portsOf, type Draft } from './workflow-model.ts'

// The layered view of a recipe (PLAN 3.26.0, DECISIONS 161): the definition read top to bottom by rank, the way a run's
// job map reads. Nothing here touches the draft or its saved positions: the rank of a step is the longest path from the
// input along the connections that go forward. A connection that leads back to a step already above (a "send back", a
// loop) is not drawn as a line: it becomes a marker on the card it leaves.

export interface RouteTarget {
  id: string
  /** The connection itself, so a preview or a live run can say whether it was taken. */
  edgeId: string
  label: string
  /** The connection returns to a step that is above (or is) this one. */
  back: boolean
  /** The agent step number of the target, when it is a step. */
  step: number | null
}

export interface Route {
  port: string
  /** What the person reads for this way out: "Approve", "Send back", "otherwise". */
  label: string
  targets: RouteTarget[]
}

export interface LayerNode {
  node: WorkflowNode
  /** The step's number among the agent steps, in reading order; null for a gate, a branch, a join or an end. */
  step: number | null
  routes: Route[]
  /** Forward connections that arrive here. */
  incoming: number
}

export interface RecipeLayer {
  index: number
  nodes: LayerNode[]
  /** Said before a join: "both finish, then" or "all 3 finish, then". */
  joinNote: string | null
  /** Where a "+" on the line above this layer inserts a step: a connection (single step above and below). */
  insertOn: { edgeId: string } | null
}

export interface RecipeLayout {
  layers: RecipeLayer[]
  /** Steps with no connection at all: they never run, so they are not drawn as part of the flow. */
  orphans: LayerNode[]
  stepOf: ReadonlyMap<string, number>
  /** A "+" under the input card, before the first step, when there is exactly one first step. */
  insertBeforeFirst: string | null
}

const GATE_PORT_LABEL: Record<string, string> = { ok: 'Approve', rejected: 'Send back' }

function ranks(draft: Draft) {
  const ids = new Set(draft.nodes.map((node) => node.id))
  const edges = draft.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to))
  const out = new Map<string, typeof edges>()
  for (const edge of edges) out.set(edge.from, [...(out.get(edge.from) ?? []), edge])
  const hasIncoming = new Set(edges.map((edge) => edge.to))

  // Depth-first from the nodes nothing leads into, then from whatever is left (a loop with no way in): an edge to a
  // node still on the stack closes a loop, and that edge is the back edge.
  const state = new Map<string, 'open' | 'done'>()
  const back = new Set<string>()
  const visit = (start: string) => {
    const stack: { id: string; next: number }[] = [{ id: start, next: 0 }]
    state.set(start, 'open')
    while (stack.length > 0) {
      const top = stack[stack.length - 1]!
      const edge = out.get(top.id)?.[top.next++]
      if (!edge) {
        state.set(top.id, 'done')
        stack.pop()
        continue
      }
      const seen = state.get(edge.to)
      if (seen === 'open') back.add(edge.id)
      else if (seen === undefined) {
        state.set(edge.to, 'open')
        stack.push({ id: edge.to, next: 0 })
      }
    }
  }
  for (const node of draft.nodes)
    if (!hasIncoming.has(node.id) && !state.has(node.id)) visit(node.id)
  for (const node of draft.nodes) if (!state.has(node.id)) visit(node.id)

  const forward = edges.filter((edge) => !back.has(edge.id))
  const rank = new Map<string, number>(draft.nodes.map((node) => [node.id, 0]))
  // The forward edges have no loop, so repeating the relaxation settles within one pass per layer.
  for (let pass = 0; pass <= draft.nodes.length; pass++) {
    let changed = false
    for (const edge of forward) {
      const next = rank.get(edge.from)! + 1
      if (next > rank.get(edge.to)!) {
        rank.set(edge.to, next)
        changed = true
      }
    }
    if (!changed) break
  }
  return { rank, forward, back, edges }
}

export function layoutRecipe(draft: Draft): RecipeLayout {
  const { rank, forward, back, edges } = ranks(draft)
  const order = new Map(draft.nodes.map((node, index) => [node.id, index]))
  // A step nothing connects to, and that leads nowhere, is not part of the flow (it would otherwise read as a first step
  // that runs "at the same time"). When nothing at all is connected, the first step stands for the flow.
  const linked = new Set(edges.flatMap((edge) => [edge.from, edge.to]))
  const lone = draft.nodes.filter((node) => !linked.has(node.id))
  const orphanNodes = linked.size > 0 ? lone : lone.slice(1)
  const orphanIds = new Set(orphanNodes.map((node) => node.id))
  const flow = draft.nodes.filter((node) => !orphanIds.has(node.id))
  const depth = Math.max(-1, ...flow.map((node) => rank.get(node.id)!))
  const buckets: WorkflowNode[][] = Array.from({ length: depth + 1 }, () => [])
  for (const node of flow) buckets[rank.get(node.id)!]!.push(node)

  // Inside a layer, steps sit under the first of their predecessors, then in the order they were added.
  const place = new Map<string, number>()
  const layersOfNodes = buckets.map((bucket) => {
    const key = (node: WorkflowNode) => {
      const from = forward
        .filter((edge) => edge.to === node.id)
        .map((edge) => place.get(edge.from) ?? 0)
      return from.length > 0 ? Math.min(...from) : -1
    }
    const sorted = [...bucket].sort(
      (a, b) => key(a) - key(b) || order.get(a.id)! - order.get(b.id)!,
    )
    sorted.forEach((node, index) => place.set(node.id, index))
    return sorted
  })

  const stepOf = new Map<string, number>()
  let step = 0
  for (const layer of layersOfNodes)
    for (const node of layer) if (node.kind === 'agent') stepOf.set(node.id, ++step)
  for (const node of orphanNodes) if (node.kind === 'agent') stepOf.set(node.id, ++step)

  const byId = new Map(draft.nodes.map((node) => [node.id, node]))
  const incoming = new Map<string, number>()
  for (const edge of forward) incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1)

  const layers: RecipeLayer[] = layersOfNodes.map((nodes, index) => {
    const first = nodes.find((node) => node.kind === 'join')
    const count = first ? (incoming.get(first.id) ?? 0) : 0
    const above = layersOfNodes[index - 1]
    let insertOn: RecipeLayer['insertOn'] = null
    if (above && above.length === 1 && nodes.length === 1) {
      const edge = forward.find((item) => item.from === above[0]!.id && item.to === nodes[0]!.id)
      if (edge) insertOn = { edgeId: edge.id }
    }
    return {
      index,
      joinNote:
        first && count > 1
          ? count === 2
            ? 'both finish, then'
            : `all ${count} finish, then`
          : null,
      insertOn,
      nodes: nodes.map((node) => ({
        node,
        step: stepOf.get(node.id) ?? null,
        incoming: incoming.get(node.id) ?? 0,
        routes: routesOf(node, edges, back, byId, stepOf),
      })),
    }
  })

  return {
    layers,
    orphans: orphanNodes.map((node) => ({
      node,
      step: stepOf.get(node.id) ?? null,
      incoming: 0,
      routes: routesOf(node, edges, back, byId, stepOf),
    })),
    stepOf,
    insertBeforeFirst: layers[0]?.nodes.length === 1 ? layers[0].nodes[0]!.node.id : null,
  }
}

function routesOf(
  node: WorkflowNode,
  edges: Draft['edges'],
  back: ReadonlySet<string>,
  byId: ReadonlyMap<string, WorkflowNode>,
  stepOf: ReadonlyMap<string, number>,
): Route[] {
  return portsOf(node).map((port) => ({
    port: port.id,
    label:
      node.kind === 'gate'
        ? (GATE_PORT_LABEL[port.id] ?? port.label)
        : node.kind === 'branch'
          ? port.id === 'default'
            ? 'otherwise'
            : (() => {
                const rule = node.rules.find((item) => item.id === port.id)
                return rule ? describeCondition(rule.when) : port.label
              })()
          : port.label,
    targets: edges
      .filter((edge) => edge.from === node.id && edge.port === port.id)
      .map((edge) => ({
        id: edge.to,
        edgeId: edge.id,
        label: byId.get(edge.to)?.label || edge.to,
        back: back.has(edge.id),
        step: stepOf.get(edge.to) ?? null,
      })),
  }))
}

/** "step 2" for a step, its label for anything else. */
export function targetName(target: RouteTarget): string {
  return target.step === null ? target.label : `step ${target.step}`
}

const REFERENCE = /\{\{\s*(inputs|nodes)\.([a-z][a-z0-9_-]*)/gi

/** What a step reads, in the person's words: the inputs by their label, earlier steps by number. */
export function usesOf(
  node: WorkflowNode,
  draft: Draft,
  stepOf: ReadonlyMap<string, number>,
): string[] {
  const text = node.kind === 'agent' ? node.instruction : node.kind === 'gate' ? node.question : ''
  const found: string[] = []
  for (const match of text.matchAll(REFERENCE)) {
    const name = match[2]!
    const said =
      match[1]!.toLowerCase() === 'inputs'
        ? (draft.inputs.find((input) => input.name === name)?.label ?? name)
        : stepOf.has(name)
          ? `step ${stepOf.get(name)}`
          : (draft.nodes.find((item) => item.id === name)?.label ?? name)
    if (!found.includes(said)) found.push(said)
  }
  return found
}

/** "Uses: what changed · 1 retry · on failure: stop the run" */
export function agentMeta(
  node: Extract<WorkflowNode, { kind: 'agent' }>,
  draft: Draft,
  layout: Pick<RecipeLayout, 'stepOf'>,
  failedTo: RouteTarget[],
): string {
  const uses = usesOf(node, draft, layout.stepOf)
  const retries =
    node.retries === 0 ? 'no retry' : `${node.retries} ${node.retries === 1 ? 'retry' : 'retries'}`
  const failure =
    node.onFailure === 'fail_run'
      ? 'stop the run'
      : failedTo.length > 0
        ? `go to ${failedTo.map(targetName).join(', ')}`
        : 'route it (not connected yet)'
  return [uses.length > 0 ? `Uses: ${uses.join(', ')}` : null, retries, `on failure: ${failure}`]
    .filter(Boolean)
    .join(' · ')
}

/** "Runs after step 1 · beside step 3": where a step sits, in the person's words. */
export function placement(
  draft: Draft,
  layout: RecipeLayout,
  id: string,
): { after: string[]; beside: string[] } {
  const name = (other: string) => {
    const step = layout.stepOf.get(other)
    return step ? `step ${step}` : (draft.nodes.find((node) => node.id === other)?.label ?? other)
  }
  const layer = layout.layers.find((item) => item.nodes.some((entry) => entry.node.id === id))
  const back = new Set(
    layout.layers.flatMap((item) =>
      item.nodes.flatMap((entry) =>
        entry.routes.flatMap((route) =>
          route.targets
            .filter((target) => target.back)
            .map((target) => `${entry.node.id}>${target.id}`),
        ),
      ),
    ),
  )
  const after = [
    ...new Set(
      draft.edges
        .filter(
          (edge) => edge.to === id && edge.from !== id && !back.has(`${edge.from}>${edge.to}`),
        )
        .map((edge) => edge.from),
    ),
  ].map(name)
  const beside = (layer?.nodes ?? [])
    .filter((entry) => entry.node.id !== id)
    .map((entry) => name(entry.node.id))
  return { after, beside }
}
