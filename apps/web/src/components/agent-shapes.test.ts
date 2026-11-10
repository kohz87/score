import { OfferedShapes, ShapeSchema } from '@score/contract'
import { expect, test } from 'vitest'
import { agentShapes, drawnShape, shapeName } from './agent-shapes.ts'
import { occupancy } from './shape-raster.ts'

const grids = Object.fromEntries(
  OfferedShapes.map((shape) => [shape, occupancy(agentShapes[shape])]),
)

const pairs = OfferedShapes.flatMap((first, index) =>
  OfferedShapes.slice(index + 1).map((second) => [first, second] as const),
)

function distinct(all: Record<string, boolean[]>, first: string, second: string) {
  const a = all[first]!
  const b = all[second]!
  const differing = a.filter((cell, index) => cell !== b[index]).length
  const occupied = a.filter((cell, index) => cell || b[index]).length
  // Empty background carries no shape information; normalize by the silhouette union.
  return differing / occupied
}

test('22 names stay valid, nine are drawn, each with plain geometry', () => {
  expect(ShapeSchema.options).toHaveLength(22)
  expect(Object.keys(agentShapes).sort()).toEqual([...OfferedShapes].sort())
  for (const shape of OfferedShapes) {
    expect(agentShapes[shape].length, shape).toBeGreaterThan(0)
  }
})

test.each(ShapeSchema.options)('%s is drawn as one of the nine offered shapes', (shape) => {
  expect(OfferedShapes).toContain(drawnShape(shape))
  expect(shapeName(shape).length).toBeGreaterThan(0)
})

test('an offered name is drawn as itself and the others as their nearest', () => {
  for (const shape of OfferedShapes) expect(drawnShape(shape)).toBe(shape)
  expect(drawnShape('circle-dot')).toBe('ball')
  expect(drawnShape('diamond')).toBe('triangle')
  expect(drawnShape('star')).toBe('flower')
  expect(drawnShape('bubble')).toBe('pill')
})

test('the words people see come from the drawn shape and differ for each of the nine', () => {
  expect(OfferedShapes.map(shapeName)).toEqual([
    'ball',
    'drop',
    'peak',
    'cloud',
    'pill',
    'clover',
    'flower',
    'pebble',
    'bean',
  ])
  expect(shapeName('hexagon')).toBe('pebble')
  expect(shapeName('moon')).toBe('drop')
})

test.each(pairs)(
  '%s and %s differ in at least 15% of occupied grayscale cells',
  (first, second) => {
    expect(distinct(grids, first, second)).toBeGreaterThanOrEqual(0.15)
  },
)

test.each(OfferedShapes)('%s fills a readable share of its box and stays inside it', (shape) => {
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
})
