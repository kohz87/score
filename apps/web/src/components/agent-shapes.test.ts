import { ShapeSchema } from '@score/contract'
import { expect, test } from 'vitest'
import { agentShapes } from './agent-shapes.ts'
import { occupancy } from './shape-raster.ts'

const grids = Object.fromEntries(
  ShapeSchema.options.map((shape) => [shape, occupancy(agentShapes[shape])]),
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

test('there are twenty shapes, each with plain geometry', () => {
  expect(ShapeSchema.options).toHaveLength(20)
  for (const shape of ShapeSchema.options) {
    expect(agentShapes[shape].length, shape).toBeGreaterThan(0)
  }
})

test.each(pairs)(
  '%s and %s differ in at least 15% of occupied grayscale cells',
  (first, second) => {
    expect(distinct(grids, first, second)).toBeGreaterThanOrEqual(0.15)
  },
)

test.each(ShapeSchema.options)(
  '%s fills a readable share of its box and stays inside it',
  (shape) => {
    const cells = grids[shape]!.filter(Boolean).length
    // Neither a speck nor a wall-to-wall block: 25-80% of the 20x20 box.
    expect(cells, shape).toBeGreaterThanOrEqual(45)
    expect(cells, shape).toBeLessThanOrEqual(320)
    // The outer cells stay empty, so squash and hop never clip against the box.
    const grid = grids[shape]!
    const edge = grid.filter(
      (cell, index) => cell && (index % 20 < 1 || index % 20 > 18 || index < 20 || index >= 380),
    )
    expect(edge, shape).toHaveLength(0)
  },
)

test('exact design diamond and square differ in only 9% of the full grid', () => {
  expect(grids.diamond!.filter((cell, index) => cell !== grids.square![index]).length).toBe(36)
})
