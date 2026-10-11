import { WORKFLOW_LAYOUT_LIMIT, type WorkflowLayout, type WorkflowNode } from '@score/contract'
import { nodeSize } from '../orchestrations/LiveDiagram.tsx'
import { portsOf, type Draft } from './workflow-model.ts'

// Free placement in the editor (PLAN 7.1c): pure helpers over the draft's optional `layout`.

export const GRID = 16
export const STEP = GRID
export const BIG_STEP = GRID * 5
const PORT_PITCH = 24

type Positions = Record<string, { x: number; y: number }>

/** Editor sizes: a branch grows with its rules so every port has room. */
export function editSize(node: WorkflowNode): { w: number; h: number } {
  const base = nodeSize({ shape: node.kind })
  return { w: base.w, h: Math.max(base.h, PORT_PITCH * portsOf(node).length + 14) }
}

export const snap = (value: number, disable = false): number =>
  disable ? Math.round(value) : Math.round(value / GRID) * GRID

export const clampCoord = (value: number): number =>
  Math.min(WORKFLOW_LAYOUT_LIMIT, Math.max(0, value))

/** The draft with this layout; an empty layout is removed so the definition goes back to "auto-arranged". */
export function withLayout(draft: Draft, nodes: Positions | undefined): Draft {
  const { layout: _old, ...rest } = draft
  void _old
  if (!nodes || Object.keys(nodes).length === 0) return rest
  return { ...rest, layout: { nodes } }
}

export function layoutOf(draft: Draft): Positions {
  return draft.layout?.nodes ?? {}
}

/** Own entries only: a node may be called `constructor` or `toString` (S2-010). */
export function positionOf(positions: Positions, id: string): { x: number; y: number } | undefined {
  return Object.hasOwn(positions, id) ? positions[id] : undefined
}

/**
 * Moves one node. The first move pins every node where it is drawn now (`current`), so the saved version reopens exactly
 * as it looked and later edits cannot shuffle the rest.
 */
export function moveNode(
  draft: Draft,
  current: ReadonlyMap<string, { x: number; y: number }>,
  id: string,
  to: { x: number; y: number },
): Draft {
  const nodes: Positions = { ...layoutOf(draft) }
  for (const node of draft.nodes) {
    const at = positionOf(nodes, node.id) ?? current.get(node.id)
    if (at) nodes[node.id] = { x: at.x, y: at.y }
  }
  nodes[id] = { x: clampCoord(to.x), y: clampCoord(to.y) }
  return withLayout(draft, nodes)
}

const overlaps = (a: { x: number; y: number; w: number; h: number }, b: typeof a): boolean =>
  a.x < b.x + b.w + 8 && b.x < a.x + a.w + 8 && a.y < b.y + b.h + 8 && b.y < a.y + a.h + 8

/**
 * A new node in a drawing the person arranged: right of the node it follows, otherwise below everything, and moved
 * down until it overlaps nothing. Without a saved layout nothing is pinned (the automatic layout places it).
 */
export function placeNewNode(
  draft: Draft,
  id: string,
  current: ReadonlyMap<string, { x: number; y: number }>,
  after: string | null,
): Draft {
  if (!draft.layout) return draft
  const node = draft.nodes.find((n) => n.id === id)
  if (!node) return draft
  const size = editSize(node)
  const others = draft.nodes
    .filter((n) => n.id !== id)
    .flatMap((n) => {
      const at = positionOf(layoutOf(draft), n.id) ?? current.get(n.id)
      return at ? [{ ...at, w: editSize(n).w, h: editSize(n).h }] : []
    })
  const source = after ? draft.nodes.find((n) => n.id === after) : undefined
  const sourceAt = source
    ? (positionOf(layoutOf(draft), source.id) ?? current.get(source.id))
    : undefined
  let x = GRID
  let y = Math.max(0, ...others.map((o) => o.y + o.h)) + GRID * 2
  if (source && sourceAt) {
    x = snap(sourceAt.x + editSize(source).w + GRID * 6)
    y = snap(sourceAt.y)
  }
  for (let guard = 0; guard < 60; guard++) {
    const hit = others.find((o) => overlaps({ x, y, ...size }, o))
    if (!hit) break
    y = snap(hit.y + hit.h + GRID)
  }
  return withLayout(draft, { ...layoutOf(draft), [id]: { x: clampCoord(x), y: clampCoord(y) } })
}

export type { WorkflowLayout }
