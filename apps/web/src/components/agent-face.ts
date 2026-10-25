// 2.2.0 (decision 127): the geometry of an agent's face. The look and the moods follow the owner's "agents with eyes"
// mock-up (SHAPES / avatar() there, drawn on a 120 box); this table is the same idea in AgentGlyph's 20 box, fitted to
// each of the 22 silhouettes. Eyes are blank white sockets: a squircle (rounded, slightly rectangular, straight sides),
// mirrored tilt on the right eye, no pupils.
import type { Shape } from '@score/contract'

export type FaceMood = 'idle' | 'thinking' | 'working' | 'needs' | 'done' | 'resting'

export type FaceLayout = {
  /** Eye centre y. */
  y: number
  /** Distance of each eye centre from the face centre (x = 10 + shift). */
  gap: number
  shift?: number
  w: number
  h: number
  /** 0.5523 is a circle/ellipse, 1 a capsule. */
  round: number
  /** Degrees; the left eye gets -tilt, the right +tilt unless `same`. */
  tilt: number
  same?: boolean
  /** How far (user units) the gaze may move an eye sideways / vertically without poking out of the silhouette. */
  lx: number
  ly: number
  /** Diameter of the round "shocked" eyes where the formula's size would not fit. */
  shock?: number
}

const layout = (l: FaceLayout): FaceLayout => l

// Mock-up proportions (120 box) for drop, triangle, cloud, pill, ball and flower, divided by six; the rest are fitted by
// hand and proven inside their silhouette by agent-face.test.ts.
export const faceLayouts: Record<Shape, FaceLayout> = {
  // The eyes replace the centre dot and sit inside the ring's hole.
  'circle-dot': layout({ y: 10, gap: 1.85, w: 1.8, h: 3, round: 0.8, tilt: 0, lx: 0.5, ly: 0.4 }),
  triangle: layout({ y: 11.7, gap: 2.1, w: 2.2, h: 3.9, round: 0.82, tilt: 0, lx: 0.6, ly: 0.4 }),
  diamond: layout({ y: 10, gap: 2.7, w: 2.6, h: 4.4, round: 0.82, tilt: 0, lx: 0.9, ly: 0.7 }),
  square: layout({ y: 9.9, gap: 2.7, w: 2.6, h: 4.6, round: 0.8, tilt: 0, lx: 1, ly: 0.8 }),
  hexagon: layout({ y: 10, gap: 3.1, w: 3, h: 5.2, round: 0.8, tilt: 0, lx: 1, ly: 0.8 }),
  star: layout({ y: 10.2, gap: 1.55, w: 1.7, h: 3, round: 0.8, tilt: 0, lx: 0.4, ly: 0.3 }),
  pill: layout({ y: 10, gap: 3.6, w: 4.1, h: 5, round: 0.78, tilt: 0, lx: 1, ly: 0.7 }),
  cross: layout({ y: 10, gap: 2, w: 1.7, h: 3, round: 0.8, tilt: 0, lx: 0.5, ly: 0.3 }),
  cloud: layout({
    y: 11.1,
    gap: 3,
    w: 4.2,
    h: 2.4,
    round: 0.8,
    tilt: 14,
    lx: 0.5,
    ly: 0.4,
    shock: 3.2,
  }),
  cylinder: layout({ y: 9.8, gap: 2.3, w: 2.2, h: 4.4, round: 0.8, tilt: 0, lx: 0.5, ly: 0.8 }),
  heart: layout({ y: 9, gap: 2.6, w: 2.6, h: 3.8, round: 0.82, tilt: 0, lx: 0.8, ly: 0.6 }),
  drop: layout({ y: 12, gap: 2.4, w: 2.9, h: 4.6, round: 0.8, tilt: 6, lx: 0.4, ly: 0.5 }),
  bolt: layout({
    y: 10.1,
    gap: 1.25,
    shift: 1.1,
    w: 1.1,
    h: 1.8,
    round: 0.9,
    tilt: 0,
    lx: 0.15,
    ly: 0.1,
  }),
  moon: layout({
    y: 10,
    gap: 1.5,
    shift: -3,
    w: 1.7,
    h: 3.6,
    round: 0.8,
    tilt: 0,
    lx: 0.4,
    ly: 0.5,
  }),
  leaf: layout({ y: 10.2, gap: 2.2, w: 2.2, h: 3.4, round: 0.8, tilt: 0, lx: 0.5, ly: 0.4 }),
  blob: layout({ y: 9.4, gap: 2.6, w: 2.6, h: 4.4, round: 0.8, tilt: 0, lx: 0.8, ly: 0.7 }),
  shield: layout({ y: 8.9, gap: 3, w: 2.7, h: 4.6, round: 0.8, tilt: 0, lx: 0.8, ly: 0.7 }),
  octagon: layout({ y: 10, gap: 3.2, w: 3, h: 5.4, round: 0.8, tilt: 0, lx: 1, ly: 0.8 }),
  bubble: layout({ y: 8.7, gap: 3.4, w: 3, h: 5.2, round: 0.8, tilt: 0, lx: 1, ly: 0.7 }),
  gem: layout({ y: 7.9, gap: 2.8, w: 2.6, h: 4.2, round: 0.8, tilt: 0, lx: 0.8, ly: 0.6 }),
  ball: layout({
    y: 8.7,
    gap: 2.8,
    shift: 1,
    w: 2.7,
    h: 6,
    round: 0.86,
    tilt: 0,
    same: true,
    lx: 0.9,
    ly: 0.6,
  }),
  flower: layout({ y: 10, gap: 2.8, w: 2.3, h: 4.5, round: 0.84, tilt: -24, lx: 0.8, ly: 0.7 }),
}

/** A squircle socket centred on the origin: a rounded rectangle with gently rounded sides (the mock-up's socket()). */
export function socketPath(w: number, h: number, round: number): string {
  const kx = (w / 2) * round
  const ky = (h / 2) * round
  const f = (n: number) => +n.toFixed(3)
  const t = -h / 2
  const b = h / 2
  const r = w / 2
  const l = -w / 2
  return [
    `M0 ${f(t)}`,
    `C${f(kx)} ${f(t)} ${f(r)} ${f(-ky)} ${f(r)} 0`,
    `C${f(r)} ${f(ky)} ${f(kx)} ${f(b)} 0 ${f(b)}`,
    `C${f(-kx)} ${f(b)} ${f(l)} ${f(ky)} ${f(l)} 0`,
    `C${f(l)} ${f(-ky)} ${f(-kx)} ${f(t)} 0 ${f(t)}Z`,
  ].join(' ')
}

const STEPS = 12

/** The socket flattened to points (also what the geometry test samples). */
export function socketPoints(w: number, h: number, round: number): [number, number][] {
  const kx = (w / 2) * round
  const ky = (h / 2) * round
  const t = -h / 2
  const b = h / 2
  const r = w / 2
  const l = -w / 2
  const segments: [number, number][][] = [
    [
      [0, t],
      [kx, t],
      [r, -ky],
      [r, 0],
    ],
    [
      [r, 0],
      [r, ky],
      [kx, b],
      [0, b],
    ],
    [
      [0, b],
      [-kx, b],
      [l, ky],
      [l, 0],
    ],
    [
      [l, 0],
      [l, -ky],
      [-kx, t],
      [0, t],
    ],
  ]
  const points: [number, number][] = []
  for (const [p0, p1, p2, p3] of segments) {
    for (let i = 0; i < STEPS; i++) {
      const s = i / STEPS
      const m = 1 - s
      points.push([
        m ** 3 * p0![0] + 3 * m * m * s * p1![0] + 3 * m * s * s * p2![0] + s ** 3 * p3![0],
        m ** 3 * p0![1] + 3 * m * m * s * p1![1] + 3 * m * s * s * p2![1] + s ** 3 * p3![1],
      ])
    }
  }
  return points
}

/**
 * A half-lidded socket: the mock-up lays a lid in the body colour over the top ~48% of the eye. Drawing only what is
 * left (the socket cut flat at that height) needs no body colour, so it also works on the ring and on any theme.
 */
export function lidPoints(
  w: number,
  h: number,
  round: number,
  fraction = 0.48,
): [number, number][] {
  const cut = -h / 2 + h * fraction
  const kept = socketPoints(w, h, round).filter(([, y]) => y >= cut)
  if (kept.length === 0) return []
  const widthAtCut = (w / 2) * Math.sqrt(Math.max(0, 1 - (cut / (h / 2)) ** 2))
  return [[-Math.max(widthAtCut, 0.3), cut], [Math.max(widthAtCut, 0.3), cut], ...kept]
}

const lidPath = (w: number, h: number, round: number) =>
  `M${lidPoints(w, h, round)
    .map(([x, y]) => `${+x.toFixed(3)} ${+y.toFixed(3)}`)
    .join(' L')} Z`

export type FaceEye = {
  /** Eye centre. */
  x: number
  y: number
  tilt: number
  /** The socket outline around the origin; the group is placed and tilted at x, y. */
  d: string
  /** The socket as points around the origin (for tests). */
  points: [number, number][]
}

export type FaceGeometry = {
  eyes: FaceEye[]
  /** Happy ^ ^ arcs (done): white strokes in place of the eyes. */
  arcs: string[]
  arcPoints: [number, number][][]
  layout: FaceLayout
}

const FLAT_H = 0.85
const MIN_FLAT_W = 2.83

export function eyeSize(
  l: FaceLayout,
  mood: FaceMood,
): { w: number; h: number; round: number; tilt: number } {
  switch (mood) {
    case 'thinking':
      return {
        w: Math.max(l.w, Math.min(MIN_FLAT_W, l.gap * 2 - 0.7)),
        h: FLAT_H,
        round: 1,
        tilt: 0,
      }
    case 'needs': {
      // Big round "shocked" eyes, sized to fit the shape.
      const d = l.shock ?? Math.min(Math.max(l.w, l.h * 0.72) * 1.15, l.gap * 2 - 1, 5)
      return { w: d, h: d, round: 0.5523, tilt: 0 }
    }
    default:
      return { w: l.w, h: l.h, round: l.round, tilt: l.tilt }
  }
}

export function faceGeometry(shape: Shape, mood: FaceMood): FaceGeometry {
  const l = faceLayouts[shape]
  const cx = 10 + (l.shift ?? 0)
  const size = eyeSize(l, mood)
  const lidded = mood === 'working' || mood === 'resting'
  const eyes: FaceEye[] = [-1, 1].map((side) => {
    const points = lidded
      ? lidPoints(size.w, size.h, size.round)
      : socketPoints(size.w, size.h, size.round)
    return {
      x: cx + side * l.gap,
      y: l.y,
      tilt: size.tilt * (l.same ? 1 : side),
      d: lidded ? lidPath(size.w, size.h, size.round) : socketPath(size.w, size.h, size.round),
      points,
    }
  })
  // Happy arcs stay apart: each is narrower than the distance to the face centre.
  const half = Math.min(1.83, l.gap - 0.45)
  const arcs: string[] = []
  const arcPoints: [number, number][][] = []
  for (const side of [-1, 1]) {
    const bx = cx + side * l.gap
    const y = l.y
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
        ] as [number, number]
      }),
    )
  }
  return { eyes, arcs, arcPoints, layout: l }
}

export const ARC_STROKE = 0.92

/** Where the eyes live relative to the silhouette: circle-dot's eyes replace its centre dot. */
export function faceHidesCentreDot(shape: Shape): boolean {
  return shape === 'circle-dot'
}

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
