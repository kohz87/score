import type { FlowLayoutEdge, FlowLayoutNode, FlowLayoutResult, Point } from './layout.ts'

// Free placement (PLAN 7.1c): positions the person chose win over the automatic layout, and the edges that touch a
// moved node are routed again. Pure, no DOM. Nodes without a position keep their automatic place.

export type PositionMap = ReadonlyMap<string, { x: number; y: number }>

const LANE = 18
const STUB = 16

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * One edge between two placed nodes. Forward edges leave the right side and enter the left side with a vertical run
 * in the gap; an edge that runs backwards (or overlaps in x) swings out of the right side, under both nodes and into
 * the left side.
 */
export function routeEdge(from: Rect, to: Rect, startY?: number): Point[] {
  const y1 = startY ?? from.y + from.h / 2
  const y2 = to.y + to.h / 2
  const p = { x: from.x + from.w, y: y1 }
  const q = { x: to.x, y: y2 }
  if (q.x - p.x >= 2 * STUB) {
    const mx = Math.round((p.x + q.x) / 2)
    return [p, { x: mx, y: y1 }, { x: mx, y: y2 }, q]
  }
  const low = Math.max(from.y + from.h, to.y + to.h) + LANE
  return [
    p,
    { x: p.x + STUB, y: y1 },
    { x: p.x + STUB, y: low },
    { x: q.x - STUB, y: low },
    { x: q.x - STUB, y: y2 },
    q,
  ]
}

export interface FreeLayoutOptions {
  marginX: number
  marginY: number
  /** Extra room right of and below the drawing (the editor leaves some to drag into). */
  slack?: { x: number; y: number }
  /** Where on its source node an edge starts (the editor spreads ports along the side). */
  startY?: (edgeId: string, from: Rect) => number
}

export function withPositions(
  auto: FlowLayoutResult,
  nodes: readonly FlowLayoutNode[],
  edges: readonly FlowLayoutEdge[],
  positions: PositionMap | undefined,
  options: FreeLayoutOptions,
): FlowLayoutResult {
  if (!positions || positions.size === 0) {
    if (!options.slack) return auto
  }
  const size = new Map(nodes.map((n) => [n.id, n]))
  const placed = new Map<string, { x: number; y: number }>()
  const moved = new Set<string>()
  for (const n of auto.nodes) {
    const own = positions?.get(n.id)
    if (own && size.has(n.id)) {
      placed.set(n.id, { x: Math.max(0, own.x), y: Math.max(0, own.y) })
      moved.add(n.id)
    } else placed.set(n.id, { x: n.x, y: n.y })
  }
  const rect = (id: string): Rect | null => {
    const at = placed.get(id)
    const s = size.get(id)
    return at && s ? { x: at.x, y: at.y, w: s.width, h: s.height } : null
  }
  const byId = new Map(edges.map((e) => [e.id, e]))
  const routes = auto.edges.map((route) => {
    const e = byId.get(route.id)
    if (!e || !(moved.has(e.from) || moved.has(e.to))) return route
    const a = rect(e.from)
    const b = rect(e.to)
    if (!a || !b) return route
    const points = routeEdge(a, b, options.startY?.(e.id, a))
    return { id: route.id, points, back: points.length > 4 }
  })
  let width = 0
  let height = 0
  for (const id of placed.keys()) {
    const r = rect(id)!
    width = Math.max(width, r.x + r.w)
    height = Math.max(height, r.y + r.h)
  }
  for (const route of routes)
    for (const pt of route.points) {
      width = Math.max(width, pt.x)
      height = Math.max(height, pt.y)
    }
  // An unmoved automatic layout already knows its own size; only grow it.
  width = Math.max(
    moved.size > 0 ? 0 : auto.width,
    width + options.marginX + (options.slack?.x ?? 0),
  )
  height = Math.max(
    moved.size > 0 ? 0 : auto.height,
    height + options.marginY + (options.slack?.y ?? 0),
  )
  return {
    nodes: auto.nodes.map((n) => ({ id: n.id, ...placed.get(n.id)! })),
    edges: routes,
    width,
    height,
  }
}
