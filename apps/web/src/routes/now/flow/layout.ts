// Pure layered layout for the Flow view: Kahn layering (longest path), barycentric ordering,
// back-edges ("sent back" and cycle closers) routed below the nodes. No React, no DOM.

export interface FlowLayoutNode {
  id: string
  width: number
  height: number
}
export interface FlowLayoutEdge {
  id: string
  from: string
  to: string
  kind: string
}
export interface FlowLayoutInput {
  nodes: FlowLayoutNode[]
  edges: FlowLayoutEdge[]
}
export interface FlowLayoutOptions {
  columnGap?: number
  rowGap?: number
  /** Sets both margins; marginX/marginY override it. */
  margin?: number
  marginX?: number
  marginY?: number
  backLaneGap?: number
  sweeps?: number
}
export interface Point {
  x: number
  y: number
}
export interface FlowLayoutResult {
  nodes: { id: string; x: number; y: number }[]
  edges: { id: string; points: Point[]; back: boolean }[]
  width: number
  height: number
}

// Measured from docs/design/html/now-flow.html: 200x84 cards at x = 16, 280, 544, 808 (column gap 64) and
// y = 40, 180, 320 (row gap 56); the canvas keeps 16px at the sides and 40px above and below.
const DEFAULTS = { columnGap: 64, rowGap: 56, marginX: 16, marginY: 40, backLaneGap: 18, sweeps: 4 }

export function layoutFlow(
  input: FlowLayoutInput,
  options: FlowLayoutOptions = {},
): FlowLayoutResult {
  const o = {
    ...DEFAULTS,
    ...options,
    marginX: options.marginX ?? options.margin ?? DEFAULTS.marginX,
    marginY: options.marginY ?? options.margin ?? DEFAULTS.marginY,
  }
  const index = new Map<string, number>()
  input.nodes.forEach((n, i) => index.set(n.id, i))
  const n = input.nodes.length

  // Edges with unknown endpoints can't be drawn; drop them.
  const edges = input.edges.filter((e) => index.has(e.from) && index.has(e.to))

  // 1. Classify back-edges: explicit sent_back, self-loops, then DFS cycle closers.
  const back = new Set<string>()
  const out: FlowLayoutEdge[][] = Array.from({ length: n }, () => [])
  for (const e of edges) {
    if (e.kind === 'sent_back' || e.from === e.to) back.add(e.id)
    else out[index.get(e.from)!]!.push(e)
  }
  const state = new Array<number>(n).fill(0) // 0 new, 1 on stack, 2 done
  const visit = (start: number): void => {
    const stack: { v: number; i: number }[] = [{ v: start, i: 0 }]
    state[start] = 1
    while (stack.length > 0) {
      const top = stack[stack.length - 1]!
      const list = out[top.v]!
      if (top.i >= list.length) {
        state[top.v] = 2
        stack.pop()
        continue
      }
      const e = list[top.i++]!
      const w = index.get(e.to)!
      if (state[w] === 1) back.add(e.id)
      else if (state[w] === 0) {
        state[w] = 1
        stack.push({ v: w, i: 0 })
      }
    }
  }
  for (let v = 0; v < n; v++) if (state[v] === 0) visit(v)

  const forward = edges.filter((e) => !back.has(e.id))

  // 2. Kahn layering, longest path from the sources.
  const indeg = new Array<number>(n).fill(0)
  const succ: number[][] = Array.from({ length: n }, () => [])
  const pred: number[][] = Array.from({ length: n }, () => [])
  for (const e of forward) {
    const a = index.get(e.from)!
    const b = index.get(e.to)!
    succ[a]!.push(b)
    pred[b]!.push(a)
    indeg[b]!++
  }
  const layerOf = new Array<number>(n).fill(0)
  const queue: number[] = []
  for (let v = 0; v < n; v++) if (indeg[v] === 0) queue.push(v)
  for (let h = 0; h < queue.length; h++) {
    const v = queue[h]!
    for (const w of succ[v]!) {
      layerOf[w] = Math.max(layerOf[w]!, layerOf[v]! + 1)
      if (--indeg[w]! === 0) queue.push(w)
    }
  }
  const layerCount = n === 0 ? 0 : Math.max(...layerOf) + 1
  const layers: number[][] = Array.from({ length: layerCount }, () => [])
  for (let v = 0; v < n; v++) layers[layerOf[v]!]!.push(v)

  // 3. Barycentric ordering, alternating sweeps; ties keep the previous order (stable).
  const pos = new Array<number>(n).fill(0)
  const syncPos = (): void => layers.forEach((l) => l.forEach((v, i) => (pos[v] = i)))
  syncPos()
  const reorder = (l: number[], neighbours: number[][]): void => {
    const bary = new Map<number, number>()
    for (const v of l) {
      const ns = neighbours[v]!
      bary.set(v, ns.length === 0 ? pos[v]! : ns.reduce((s, w) => s + pos[w]!, 0) / ns.length)
    }
    l.sort((a, b) => bary.get(a)! - bary.get(b)! || pos[a]! - pos[b]!)
    l.forEach((v, i) => (pos[v] = i))
  }
  for (let s = 0; s < o.sweeps; s++) {
    for (let i = 1; i < layerCount; i++) reorder(layers[i]!, pred)
    for (let i = layerCount - 2; i >= 0; i--) reorder(layers[i]!, succ)
  }

  // 4. Coordinates: columns left to right, nodes stacked and centred per column.
  const colHeight = layers.map(
    (l) => l.reduce((s, v) => s + input.nodes[v]!.height, 0) + Math.max(0, l.length - 1) * o.rowGap,
  )
  const contentH = colHeight.length ? Math.max(...colHeight) : 0
  const px = new Array<number>(n).fill(0)
  const py = new Array<number>(n).fill(0)
  let x = o.marginX
  layers.forEach((l, i) => {
    let y = o.marginY + (contentH - colHeight[i]!) / 2
    let colW = 0
    for (const v of l) {
      const node = input.nodes[v]!
      px[v] = x
      py[v] = y
      y += node.height + o.rowGap
      colW = Math.max(colW, node.width)
    }
    x += colW + o.columnGap
  })
  const contentRight = layerCount ? x - o.columnGap : o.marginX
  const contentBottom = o.marginY + contentH

  // 5. Edge routing.
  const mid = (v: number, side: 'l' | 'r' | 'b'): Point => {
    const node = input.nodes[v]!
    if (side === 'l') return { x: px[v]!, y: py[v]! + node.height / 2 }
    if (side === 'r') return { x: px[v]! + node.width, y: py[v]! + node.height / 2 }
    return { x: px[v]! + node.width / 2, y: py[v]! + node.height }
  }
  let lane = 0
  const routed = edges.map((e) => {
    const a = index.get(e.from)!
    const b = index.get(e.to)!
    if (!back.has(e.id)) {
      const p = mid(a, 'r')
      const q = mid(b, 'l')
      const mx = (p.x + q.x) / 2
      return { id: e.id, back: false, points: [p, { x: mx, y: p.y }, { x: mx, y: q.y }, q] }
    }
    if (e.kind === 'sent_back' && layerOf[a]! === layerOf[b]! + 1) {
      const p = mid(a, 'l')
      const q = mid(b, 'r')
      // Separate the return arrow from the forward review arrow, inside the column gap.
      p.y += input.nodes[a]!.height / 3
      q.y += input.nodes[b]!.height / 3
      const mx = (p.x + q.x) / 2
      return { id: e.id, back: true, points: [p, { x: mx, y: p.y }, { x: mx, y: q.y }, q] }
    }
    const p = mid(a, 'b')
    const q = mid(b, 'b')
    const ly = contentBottom + o.backLaneGap * (1 + lane++)
    // Self-loops get a small offset so the path has real width.
    const qx = a === b ? q.x + 24 : q.x
    return {
      id: e.id,
      back: true,
      points: [p, { x: p.x, y: ly }, { x: qx, y: ly }, { x: qx, y: q.y }],
    }
  })

  const height = contentBottom + (lane ? o.backLaneGap * (lane + 1) : 0) + o.marginY
  return {
    nodes: input.nodes.map((node, v) => ({ id: node.id, x: px[v]!, y: py[v]! })),
    edges: routed,
    width: contentRight + o.marginX,
    height,
  }
}
