import { ShapeSchema } from '@score/contract'
import { expect, test } from 'vitest'
import { agentEyes, agentShapes, markBodies } from './agent-shapes.ts'
import { occupancy, painted } from './shape-raster.ts'

const grids = Object.fromEntries(
  ShapeSchema.options.map((shape) => [shape, occupancy(agentShapes[shape])]),
)
const markGrids = Object.fromEntries(
  ShapeSchema.options.map((shape) => [shape, occupancy(markBodies[shape])]),
)

const pairs = ShapeSchema.options.flatMap((first, index) =>
  ShapeSchema.options.slice(index + 1).map((second) => [first, second] as const),
)

function distinct(all: Record<string, boolean[]>, first: string, second: string) {
  const a = all[first]!
  const b = all[second]!
  const differing = a.filter((cell, index) => cell !== b[index]).length
  const occupied = a.filter((cell, index) => cell || b[index]).length
  // Empty background carries no shape information; normalize by the silhouette union.
  return differing / occupied
}

test('there are twenty shapes, each with plain geometry, a mark body and eyes', () => {
  expect(ShapeSchema.options).toHaveLength(20)
  for (const shape of ShapeSchema.options) {
    expect(agentShapes[shape].length, shape).toBeGreaterThan(0)
    expect(markBodies[shape].length, shape).toBeGreaterThan(0)
    expect(agentEyes[shape].xs, shape).toHaveLength(2)
  }
})

test.each(pairs)(
  '%s and %s differ in at least 15% of occupied grayscale cells',
  (first, second) => {
    expect(distinct(grids, first, second)).toBeGreaterThanOrEqual(0.15)
  },
)

test.each(pairs)(
  'as marks, %s and %s differ in at least 15% of occupied cells',
  (first, second) => {
    expect(distinct(markGrids, first, second)).toBeGreaterThanOrEqual(0.15)
  },
)

test.each(ShapeSchema.options)(
  '%s fills a readable share of its box and stays inside it',
  (shape) => {
    const cells = markGrids[shape]!.filter(Boolean).length
    // Neither a speck nor a wall-to-wall block: 25-80% of the 20x20 box.
    expect(cells, shape).toBeGreaterThanOrEqual(45)
    expect(cells, shape).toBeLessThanOrEqual(320)
    // The outer cells stay empty, so squash and hop never clip against the box.
    const grid = markGrids[shape]!
    const edge = grid.filter(
      (cell, index) => cell && (index % 20 < 1 || index % 20 > 18 || index < 20 || index >= 380),
    )
    expect(edge, shape).toHaveLength(0)
  },
)

test.each(ShapeSchema.options)(
  '%s has both eyes inside its body, apart, and clear of any hole',
  (shape) => {
    const { y, xs, w, h } = agentEyes[shape]
    const inside = painted(markBodies[shape])
    for (const x of xs) {
      // Every corner and the middle of the eye lies on the body (an eye on the rim or in a hole is a bug).
      for (const [dx, dy] of [
        [-1, -1],
        [1, -1],
        [-1, 1],
        [1, 1],
        [0, 0],
      ] as const) {
        expect(inside(x + (dx * w) / 2, y + (dy * h) / 2), `${shape} eye at ${x}`).toBe(true)
      }
    }
    expect(xs[1] - xs[0] - w, `${shape} eyes`).toBeGreaterThanOrEqual(0.7)
  },
)

test("the lead's mark is one round shape, and the plain list shape keeps its ring and dot", () => {
  expect(markBodies['circle-dot']).toEqual([{ tag: 'circle', cx: 10, cy: 10, r: 8 }])
  expect(agentShapes['circle-dot']).toHaveLength(2)
  for (const shape of ShapeSchema.options.filter((name) => name !== 'circle-dot')) {
    expect(markBodies[shape], shape).toBe(agentShapes[shape])
  }
})

test('exact design diamond and square differ in only 9% of the full grid', () => {
  expect(grids.diamond!.filter((cell, index) => cell !== grids.square![index]).length).toBe(36)
})
