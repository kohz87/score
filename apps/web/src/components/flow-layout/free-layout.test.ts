import { expect, test } from 'vitest'
import { layoutFlow } from './layout.ts'
import { routeEdge, withPositions } from './free-layout.ts'

const nodes = [
  { id: 'a', width: 100, height: 50 },
  { id: 'b', width: 100, height: 50 },
  { id: 'c', width: 100, height: 50 },
]
const edges = [
  { id: 'e1', from: 'a', to: 'b', kind: 'flow' },
  { id: 'e2', from: 'b', to: 'c', kind: 'flow' },
]
const options = { marginX: 10, marginY: 10 }
const auto = layoutFlow({ nodes, edges }, options)

test('without positions the automatic layout is returned untouched', () => {
  expect(withPositions(auto, nodes, edges, undefined, options)).toBe(auto)
  expect(withPositions(auto, nodes, edges, new Map(), options)).toBe(auto)
})

test('a chosen position wins, the others stay, and only edges at the moved node are routed again', () => {
  const out = withPositions(auto, nodes, edges, new Map([['b', { x: 400, y: 300 }]]), options)
  expect(out.nodes.find((n) => n.id === 'b')).toEqual({ id: 'b', x: 400, y: 300 })
  expect(out.nodes.find((n) => n.id === 'a')).toEqual(auto.nodes.find((n) => n.id === 'a'))
  // Both edges touch b, so both follow it: they end at b's left side / start at b's right side.
  const e1 = out.edges.find((e) => e.id === 'e1')!.points
  expect(e1.at(-1)).toEqual({ x: 400, y: 325 })
  const e2 = out.edges.find((e) => e.id === 'e2')!.points
  expect(e2[0]).toEqual({ x: 500, y: 325 })
  expect(out.width).toBeGreaterThanOrEqual(510 + options.marginX)
  // c (still in its automatic place) is now left of b, so e2 swings 18 px under b before the margin.
  expect(out.height).toBe(350 + 18 + options.marginY)
})

test('an edge between untouched nodes keeps the automatic route', () => {
  const out = withPositions(auto, nodes, edges, new Map([['c', { x: 0, y: 0 }]]), options)
  expect(out.edges.find((e) => e.id === 'e1')).toEqual(auto.edges.find((e) => e.id === 'e1'))
})

test('negative positions are clamped to the canvas', () => {
  const out = withPositions(auto, nodes, edges, new Map([['a', { x: -50, y: -9 }]]), options)
  expect(out.nodes.find((n) => n.id === 'a')).toEqual({ id: 'a', x: 0, y: 0 })
})

test('slack leaves room to drag into', () => {
  const plain = withPositions(auto, nodes, edges, new Map([['a', { x: 0, y: 0 }]]), options)
  const roomy = withPositions(auto, nodes, edges, new Map([['a', { x: 0, y: 0 }]]), {
    ...options,
    slack: { x: 160, y: 120 },
  })
  expect(roomy.width).toBe(plain.width + 160)
  expect(roomy.height).toBe(plain.height + 120)
})

test('a forward edge runs through the gap; a backward edge swings under both nodes', () => {
  const left = { x: 0, y: 0, w: 100, h: 40 }
  const right = { x: 300, y: 100, w: 100, h: 40 }
  expect(routeEdge(left, right)).toEqual([
    { x: 100, y: 20 },
    { x: 200, y: 20 },
    { x: 200, y: 120 },
    { x: 300, y: 120 },
  ])
  const back = routeEdge(right, left)
  expect(back).toHaveLength(6)
  expect(back[0]).toEqual({ x: 400, y: 120 })
  expect(back.at(-1)).toEqual({ x: 0, y: 20 })
  // Under both nodes (the lower bottom edge is 140).
  expect(back[2]!.y).toBeGreaterThan(140)
  // Touching nodes still get a legible route.
  expect(routeEdge({ x: 0, y: 0, w: 100, h: 40 }, { x: 110, y: 0, w: 100, h: 40 })).toHaveLength(6)
  expect(routeEdge(left, right, 30)[0]).toEqual({ x: 100, y: 30 })
})
