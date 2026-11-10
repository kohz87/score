// 2.2.0 (decision 127), reworked by decision 184: the geometry of an agent's face. Each of the nine drawn shapes has
// its own eyes (agent-eyes.ts); the moods keep their meaning on every shape, at the eye centres: idle is the shape's
// own eyes, thinking flat line eyes, needs round "shocked" eyes, working / resting the own eyes cut flat across (the
// lid) and done the happy ^ ^ arcs. Eyes are blank white sockets, no pupils.
import type { Shape } from '@score/contract'
import {
  discPath,
  eyeBox,
  eyePath,
  lidPoints,
  outlinePoints,
  pointsPath,
  roundedRectPath,
  shapeEyes,
  type Point,
} from './agent-eyes.ts'
import { drawnShape, type OfferedShape } from './agent-shapes.ts'

export type FaceMood = 'idle' | 'thinking' | 'working' | 'needs' | 'done' | 'resting'

export type FaceLayout = {
  /** How far (user units) the gaze may move an eye sideways / vertically without poking out of the silhouette. */
  lx: number
  ly: number
  /** Diameter of the round "shocked" eyes where the formula's size would not fit. */
  shock?: number
}

// Fitted by hand and proven inside each body by agent-face.test.ts.
export const faceLayouts: Record<OfferedShape, FaceLayout> = {
  ball: { lx: 0.9, ly: 0.6 },
  drop: { lx: 0.5, ly: 0.5 },
  triangle: { lx: 0.6, ly: 0.4 },
  cloud: { lx: 0.5, ly: 0.4 },
  pill: { lx: 0.8, ly: 0.5 },
  cross: { lx: 0.3, ly: 0.3 },
  flower: { lx: 0.5, ly: 0.5 },
  square: { lx: 1, ly: 0.8 },
  blob: { lx: 0.8, ly: 0.5 },
}

export type FaceEye = {
  /** Eye centre. */
  x: number
  y: number
  tilt: number
  /** The outline around the origin; the group is placed and tilted at x, y. */
  d: string
  /** The outline as points around the origin (the lid and the geometry test use it). */
  points: Point[]
}

export type FaceGeometry = {
  eyes: FaceEye[]
  /** Happy ^ ^ arcs (done): white strokes in place of the eyes. */
  arcs: string[]
  arcPoints: Point[][]
  layout: FaceLayout
}

const FLAT_H = 0.85
const MIN_FLAT_W = 2.83

export function faceGeometry(shape: Shape, mood: FaceMood): FaceGeometry {
  const drawn = drawnShape(shape)
  const layout = faceLayouts[drawn]
  const specs = shapeEyes[drawn]
  const distance = specs[1].x - specs[0].x
  const eyes: FaceEye[] = specs.map((spec) => {
    const own = outlinePoints(eyePath(spec))
    const box = eyeBox(own)
    const base = { x: spec.x, y: spec.y }
    switch (mood) {
      case 'thinking': {
        const w = Math.max(box.w, Math.min(MIN_FLAT_W, distance - 0.7))
        const d = roundedRectPath(w, FLAT_H, FLAT_H / 2)
        return { ...base, tilt: 0, d, points: outlinePoints(d) }
      }
      case 'needs': {
        // Big round "shocked" eyes, sized to fit the shape.
        const size = layout.shock ?? Math.min(Math.max(box.w, box.h * 0.72) * 1.15, distance - 1, 5)
        const d = discPath(+(size / 2).toFixed(3))
        return { ...base, tilt: 0, d, points: outlinePoints(d) }
      }
      case 'working':
      case 'resting': {
        const points = lidPoints(own)
        return { ...base, tilt: spec.tilt, d: pointsPath(points), points }
      }
      default:
        return { ...base, tilt: spec.tilt, d: eyePath(spec), points: own }
    }
  })
  // Happy arcs stay apart: each is narrower than the distance to the other eye.
  const half = Math.min(1.83, distance / 2 - 0.45)
  const arcs: string[] = []
  const arcPoints: Point[][] = []
  for (const { x: bx, y } of specs) {
    arcs.push(
      `M${+(bx - half).toFixed(2)} ${+(y + 0.67).toFixed(2)} Q${+bx.toFixed(2)} ${+(y - 1.83).toFixed(2)} ${+(bx + half).toFixed(2)} ${+(y + 0.67).toFixed(2)}`,
    )
    arcPoints.push(
      Array.from({ length: 9 }, (_, i) => {
        const t = i / 8
        const m = 1 - t
        return [
          m * m * (bx - half) + 2 * m * t * bx + t * t * (bx + half),
          m * m * (y + 0.67) + 2 * m * t * (y - 1.83) + t * t * (y + 0.67),
        ] as Point
      }),
    )
  }
  return { eyes, arcs, arcPoints, layout }
}

export const ARC_STROKE = 0.92

export const moodWords: Record<FaceMood, string | null> = {
  idle: null,
  resting: null,
  thinking: 'thinking',
  working: 'working',
  needs: 'needs you',
  done: 'done',
}

/** FNV-1a: a stable number per agent id, so a team doesn't blink or look about in unison. */
export function faceHash(id: string): number {
  let hash = 2166136261
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

export function faceTiming(id: string): {
  look: number
  blink: number
  delay: number
  delay2: number
} {
  const h = faceHash(id)
  const look = 8 + (h % 5) // 8..12 s per look-around cycle
  const blink = 3.6 + ((h >>> 5) % 28) / 10 // 3.6..6.3 s
  return {
    look,
    blink,
    delay: -(((h >>> 9) % 1000) / 1000) * look,
    delay2: -(((h >>> 19) % 1000) / 1000) * blink,
  }
}
