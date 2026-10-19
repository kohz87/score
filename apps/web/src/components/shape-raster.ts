// Test helper (not imported by the app): rasterises the agent shapes without a browser. jsdom has no SVG geometry, so
// paths are flattened here. Supports the absolute commands the shapes use: M L H V C Q A Z, several sub-paths, even-odd.
import type { AgentShapeElement } from './agent-shapes.ts'

export type Point = { x: number; y: number }

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

const STEPS = 48

function arcPoints(from: Point, rx: number, ry: number, large: number, sweep: number, to: Point) {
  // SVG implementation notes F.6.5 (no rotation): endpoint to centre parameterisation.
  const dx = (from.x - to.x) / 2
  const dy = (from.y - to.y) / 2
  let radiusX = Math.abs(rx)
  let radiusY = Math.abs(ry)
  const lambda = (dx * dx) / (radiusX * radiusX) + (dy * dy) / (radiusY * radiusY)
  if (lambda > 1) {
    radiusX *= Math.sqrt(lambda)
    radiusY *= Math.sqrt(lambda)
  }
  const sign = large === sweep ? -1 : 1
  const numerator =
    radiusX * radiusX * radiusY * radiusY -
    radiusX * radiusX * dy * dy -
    radiusY * radiusY * dx * dx
  const denominator = radiusX * radiusX * dy * dy + radiusY * radiusY * dx * dx
  const factor = sign * Math.sqrt(Math.max(0, numerator / denominator))
  const cxp = (factor * radiusX * dy) / radiusY
  const cyp = (-factor * radiusY * dx) / radiusX
  const cx = cxp + (from.x + to.x) / 2
  const cy = cyp + (from.y + to.y) / 2
  const start = Math.atan2((dy - cyp) / radiusY, (dx - cxp) / radiusX)
  let delta = Math.atan2((-dy - cyp) / radiusY, (-dx - cxp) / radiusX) - start
  if (!sweep && delta > 0) delta -= 2 * Math.PI
  if (sweep && delta < 0) delta += 2 * Math.PI
  const points: Point[] = []
  for (let step = 1; step <= STEPS; step++) {
    const angle = start + (delta * step) / STEPS
    points.push({ x: cx + radiusX * Math.cos(angle), y: cy + radiusY * Math.sin(angle) })
  }
  return points
}

export function pathPolygons(path: string): Point[][] {
  const tokens = path.match(/[MLHVCQAZ]|-?\d+(?:\.\d+)?/g)!
  const polygons: Point[][] = []
  let points: Point[] = []
  let current: Point = { x: 0, y: 0 }
  let index = 0
  const next = () => Number(tokens[index++]!)
  const bezier = (...control: Point[]) => {
    const all = [current, ...control]
    for (let step = 1; step <= STEPS; step++) {
      const t = step / STEPS
      let level = all
      while (level.length > 1) {
        level = level.slice(1).map((p, i) => ({
          x: level[i]!.x + (p.x - level[i]!.x) * t,
          y: level[i]!.y + (p.y - level[i]!.y) * t,
        }))
      }
      points.push(level[0]!)
    }
    current = control[control.length - 1]!
  }
  while (index < tokens.length) {
    const command = tokens[index++]!
    switch (command) {
      case 'M':
        if (points.length) polygons.push(points)
        points = []
        current = { x: next(), y: next() }
        points.push(current)
        break
      case 'L':
        current = { x: next(), y: next() }
        points.push(current)
        break
      case 'H':
        current = { ...current, x: next() }
        points.push(current)
        break
      case 'V':
        current = { ...current, y: next() }
        points.push(current)
        break
      case 'C':
        bezier({ x: next(), y: next() }, { x: next(), y: next() }, { x: next(), y: next() })
        break
      case 'Q':
        bezier({ x: next(), y: next() }, { x: next(), y: next() })
        break
      case 'A': {
        const rx = next()
        const ry = next()
        next() // rotation: the shapes use none
        const large = next()
        const sweep = next()
        const end = { x: next(), y: next() }
        points.push(...arcPoints(current, rx, ry, large, sweep, end))
        current = end
        break
      }
      case 'Z':
        break
      default:
        throw new Error(`Unsupported path command ${command}`)
    }
  }
  if (points.length) polygons.push(points)
  return polygons
}

/** Whether the point is painted by the element (rings count their stroke band, solids their area; paths even-odd). */
export function sampler(element: AgentShapeElement): (x: number, y: number) => boolean {
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
      const polygons = pathPolygons(element.d)
      return (x, y) => polygons.filter((polygon) => polygonContains(polygon, x, y)).length % 2 === 1
    }
  }
}

export function painted(elements: readonly AgentShapeElement[]): (x: number, y: number) => boolean {
  const samples = elements.map(sampler)
  return (x, y) => samples.some((sample) => sample(x, y))
}

/** The 20×20 occupancy grid used to compare silhouettes. */
export function occupancy(elements: readonly AgentShapeElement[]): boolean[] {
  const contains = painted(elements)
  return Array.from({ length: 400 }, (_, index) =>
    contains((index % 20) + 0.5, Math.floor(index / 20) + 0.5),
  )
}
