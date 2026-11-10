import { OfferedShapes, ShapeSchema } from '@score/contract'
import { expect, test } from 'vitest'
import { faceGeometry, faceHash, faceLayouts, faceTiming, type FaceMood } from './agent-face.ts'
import { shapeEyes } from './agent-eyes.ts'
import { agentShapes, type OfferedShape } from './agent-shapes.ts'
import { painted } from './shape-raster.ts'

const moods: FaceMood[] = ['idle', 'resting', 'thinking', 'working', 'needs', 'done']
const GAP = 0.12 // every sampled point must have paint this far around it
const MARGIN = 0.3 // and the whole face stays this far inside the silhouette's box

function box(shape: OfferedShape) {
  const inside = painted(agentShapes[shape])
  let x0 = 20
  let x1 = 0
  let y0 = 20
  let y1 = 0
  for (let y = 0; y < 20; y += 0.05) {
    for (let x = 0; x < 20; x += 0.05) {
      if (!inside(x, y)) continue
      x0 = Math.min(x0, x)
      x1 = Math.max(x1, x)
      y0 = Math.min(y0, y)
      y1 = Math.max(y1, y)
    }
  }
  return { x0, x1, y0, y1 }
}

/** Every point the face can occupy in this mood: the eyes (tilted, placed) at the extremes of the gaze. */
function facePoints(shape: OfferedShape, mood: FaceMood) {
  const g = faceGeometry(shape, mood)
  const out: [number, number][] = []
  const shifts =
    mood === 'done'
      ? [[0, 0]]
      : [
          [0, 0],
          [-1, -1],
          [-1, 1],
          [1, -1],
          [1, 1],
        ]
  for (const [sx, sy] of shifts) {
    const dx = sx! * g.layout.lx
    const dy = sy! * g.layout.ly
    if (mood === 'done') {
      for (const arc of g.arcPoints) out.push(...arc)
      continue
    }
    for (const eye of g.eyes) {
      const a = (eye.tilt * Math.PI) / 180
      for (const [px, py] of eye.points) {
        out.push([
          eye.x + dx + px * Math.cos(a) - py * Math.sin(a),
          eye.y + dy + px * Math.sin(a) + py * Math.cos(a),
        ])
      }
    }
  }
  return out
}

test('every one of the nine drawn shapes has a face layout, and the 22 names all have a face', () => {
  expect(Object.keys(faceLayouts).sort()).toEqual([...OfferedShapes].sort())
  for (const shape of ShapeSchema.options) {
    expect(faceGeometry(shape, 'idle').eyes, shape).toHaveLength(2)
  }
})

test.each(OfferedShapes)('%s: the face stays inside the silhouette in every mood', (shape) => {
  const b = box(shape)
  const inside = painted(agentShapes[shape])
  for (const mood of moods) {
    const points = facePoints(shape, mood)
    expect(points.length, `${shape} ${mood}`).toBeGreaterThan(0)
    for (const [x, y] of points) {
      const where = `${shape}/${mood} at ${x.toFixed(2)},${y.toFixed(2)}`
      expect(x, where).toBeGreaterThanOrEqual(b.x0 + MARGIN)
      expect(x, where).toBeLessThanOrEqual(b.x1 - MARGIN)
      expect(y, where).toBeGreaterThanOrEqual(b.y0 + MARGIN)
      expect(y, where).toBeLessThanOrEqual(b.y1 - MARGIN)
      for (const [ox, oy] of [
        [0, 0],
        [GAP, 0],
        [-GAP, 0],
        [0, GAP],
        [0, -GAP],
      ]) {
        expect(inside(x + ox!, y + oy!), where).toBe(true)
      }
    }
  }
})

test('the two eyes never touch, in any mood or gaze', () => {
  for (const shape of OfferedShapes) {
    for (const mood of moods) {
      const g = faceGeometry(shape, mood)
      const [left, right] = g.eyes as [(typeof g.eyes)[0], (typeof g.eyes)[0]]
      const extent = (eye: typeof left, dir: 1 | -1) =>
        Math.max(
          ...eye.points.map(([px, py]) => {
            const a = (eye.tilt * Math.PI) / 180
            return dir * (eye.x + px * Math.cos(a) - py * Math.sin(a))
          }),
        )
      const leftMax = extent(left, 1)
      const rightMin = -extent(right, -1)
      expect(rightMin - leftMax, `${shape}/${mood}`).toBeGreaterThan(0.2)
    }
  }
})

test('each shape thinks with flat level eyes, and needs-you eyes are round', () => {
  for (const shape of OfferedShapes) {
    const flat = faceGeometry(shape, 'thinking')
    for (const eye of flat.eyes) {
      expect(eye.tilt).toBeCloseTo(0)
      const ys = eye.points.map(([, y]) => y)
      expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(1)
    }
    const shocked = faceGeometry(shape, 'needs')
    for (const eye of shocked.eyes) {
      const xs = eye.points.map(([x]) => x)
      const ys = eye.points.map(([, y]) => y)
      expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(Math.max(...ys) - Math.min(...ys), 1)
    }
  }
})

test('working and resting cut each eye flat across at 48% of its height, thinking draws a line', () => {
  for (const shape of OfferedShapes) {
    const idle = faceGeometry(shape, 'idle').eyes
    const height = (eye: (typeof idle)[number]) => {
      const ys = eye.points.map(([, y]) => y)
      return Math.max(...ys) - Math.min(...ys)
    }
    for (const mood of ['working', 'resting'] as const) {
      faceGeometry(shape, mood).eyes.forEach((eye, index) => {
        expect(height(eye) / height(idle[index]!), `${shape}/${mood}`).toBeCloseTo(0.52, 1)
        expect(eye.x).toBe(idle[index]!.x)
        expect(eye.tilt).toBe(idle[index]!.tilt)
      })
    }
  }
})

test('the nine shapes have their own eyes: dots, bars, squares, triangles, half-moons, capsules', () => {
  const kinds = OfferedShapes.map((shape) => shapeEyes[shape][0].kind)
  expect(new Set(kinds)).toEqual(new Set(['dot', 'capsule', 'rect', 'triangle', 'half-moon']))
  expect(faceGeometry('circle-dot', 'idle').eyes[0]!.d).toBe(
    faceGeometry('ball', 'idle').eyes[0]!.d,
  )
})

test('happy arcs stay apart', () => {
  for (const shape of OfferedShapes) {
    const [a, b] = faceGeometry(shape, 'done').arcPoints as [[number, number][], [number, number][]]
    const aMax = Math.max(...a.map(([x]) => x))
    const bMin = Math.min(...b.map(([x]) => x))
    expect(bMin - aMax, shape).toBeGreaterThan(0.3)
  }
})

test('the per-agent hash differs between agents and is stable', () => {
  expect(faceHash('builder')).toBe(faceHash('builder'))
  expect(faceHash('builder')).not.toBe(faceHash('reviewer'))
  const t = faceTiming('builder')
  expect(t.look).toBeGreaterThanOrEqual(8)
  expect(t.blink).toBeGreaterThanOrEqual(3.6)
  expect(t.delay).toBeLessThanOrEqual(0)
})
