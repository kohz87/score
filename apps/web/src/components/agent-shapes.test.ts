import { ShapeSchema } from '@score/contract'
import { expect, test } from 'vitest'
import { agentShapes, type AgentShapeElement } from './agent-shapes.ts'

type Point = { x: number; y: number }

function polygonContains(points: Point[], x: number, y: number) {
  let inside = false
  for (let index = 0, previous = points.length - 1; index < points.length; previous = index++) {
    const a = points[index]!
    const b = points[previous]!
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside
    }
  }
  return inside
}

function pathPolygon(path: string): Point[] {
  const tokens = path.match(/[MLHVAZ]|-?\d+(?:\.\d+)?/g)!
  const points: Point[] = []
  let current: Point = { x: 0, y: 0 }
  let index = 0
  const next = () => Number(tokens[index++]!)
  while (index < tokens.length) {
    const command = tokens[index++]!
    switch (command) {
      case 'M':
      case 'L':
        current = { x: next(), y: next() }
        break
      case 'H':
        current = { ...current, x: next() }
        break
      case 'V':
        current = { ...current, y: next() }
        break
      case 'A': {
        const radius = next()
        const ry = next()
        const rotation = next()
        const largeArc = next()
        const sweep = next()
        const end = { x: next(), y: next() }
        // These paths use circular half-arcs; reject other arcs rather than approximate them wrongly.
        expect([ry, rotation, largeArc, sweep]).toEqual([radius, 0, 0, 1])
        expect(Math.hypot(end.x - current.x, end.y - current.y)).toBeCloseTo(radius * 2)
        const center = { x: (current.x + end.x) / 2, y: (current.y + end.y) / 2 }
        const startAngle = Math.atan2(current.y - center.y, current.x - center.x)
        for (let step = 1; step < 64; step++) {
          const angle = startAngle + (Math.PI * step) / 64
          points.push({
            x: center.x + radius * Math.cos(angle),
            y: center.y + radius * Math.sin(angle),
          })
        }
        current = end
        break
      }
      case 'Z':
        return points
      default:
        throw new Error(`Unsupported path command ${command}`)
    }
    points.push(current)
  }
  throw new Error('Expected a closed path')
}

function sampler(element: AgentShapeElement): (x: number, y: number) => boolean {
  switch (element.tag) {
    case 'circle':
      return (x, y) => {
        const distance = Math.hypot(x - element.cx, y - element.cy)
        return element.strokeWidth === undefined
          ? distance <= element.r
          : Math.abs(distance - element.r) <= element.strokeWidth / 2
      }
    case 'rect':
      return (x, y) => {
        const dx = Math.max(
          element.x + element.rx - x,
          0,
          x - (element.x + element.width - element.rx),
        )
        const dy = Math.max(
          element.y + element.rx - y,
          0,
          y - (element.y + element.height - element.rx),
        )
        return (
          x >= element.x &&
          x <= element.x + element.width &&
          y >= element.y &&
          y <= element.y + element.height &&
          dx * dx + dy * dy <= element.rx * element.rx
        )
      }
    case 'path': {
      const polygon = pathPolygon(element.d)
      return (x, y) => polygonContains(polygon, x, y)
    }
  }
}

const grids = Object.fromEntries(
  ShapeSchema.options.map((shape) => {
    const contains = agentShapes[shape].map(sampler)
    const grid = Array.from({ length: 400 }, (_, index) =>
      contains.some((sample) => sample((index % 20) + 0.5, Math.floor(index / 20) + 0.5)),
    )
    return [shape, grid]
  }),
)

const pairs = ShapeSchema.options.flatMap((first, index) =>
  ShapeSchema.options.slice(index + 1).map((second) => [first, second] as const),
)

test.each(pairs)(
  '%s and %s differ in at least 15% of occupied grayscale cells',
  (first, second) => {
    const a = grids[first]!
    const b = grids[second]!
    const differing = a.filter((cell, index) => cell !== b[index]).length
    const occupied = a.filter((cell, index) => cell || b[index]).length
    // Empty background carries no shape information; normalize by the silhouette union.
    expect(differing / occupied).toBeGreaterThanOrEqual(0.15)
  },
)

test('exact design diamond and square differ in only 9% of the full grid', () => {
  expect(grids.diamond!.filter((cell, index) => cell !== grids.square![index]).length).toBe(36)
})
