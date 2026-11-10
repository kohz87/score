// Decision 184: the eyes of the nine shapes. Each shape has two eyes of one kind at fixed centres (`tilt` in degrees,
// applied around the eye's own centre). An outline is a path of M, L, A and Z only, around the origin, so the same
// string draws the eye and (flattened) feeds the geometry tests and the lid.
import type { OfferedShape } from './agent-shapes.ts'

export type EyeSpec =
  | { kind: 'dot'; x: number; y: number; r: number; tilt: number }
  | {
      kind: 'rect' | 'capsule'
      x: number
      y: number
      w: number
      h: number
      r: number
      tilt: number
    }
  | { kind: 'half-moon'; x: number; y: number; r: number; tilt: number }
  | { kind: 'triangle'; x: number; y: number; tilt: number }

const dot = (x: number, y: number, r: number, tilt = 0): EyeSpec => ({ kind: 'dot', x, y, r, tilt })
const rect = (x: number, y: number, w: number, h: number, r: number, tilt = 0): EyeSpec => ({
  kind: 'rect',
  x,
  y,
  w,
  h,
  r,
  tilt,
})
const capsule = (x: number, y: number, w: number, h: number, tilt = 0): EyeSpec => ({
  kind: 'capsule',
  x,
  y,
  w,
  h,
  r: w / 2,
  tilt,
})
const moon = (x: number, y: number, r: number, tilt = 0): EyeSpec => ({
  kind: 'half-moon',
  x,
  y,
  r,
  tilt,
})
const cloudEye = (x: number, y: number, tilt: number): EyeSpec => ({ kind: 'triangle', x, y, tilt })

export const shapeEyes: Record<OfferedShape, [EyeSpec, EyeSpec]> = {
  ball: [dot(7.58, 9.44, 1.63), dot(12.42, 9.44, 1.63)],
  drop: [capsule(8.42, 11.86, 1.67, 3.35), capsule(11.95, 11.86, 1.67, 3.35)],
  triangle: [rect(8.23, 12.14, 2.23, 2.23, 0.47), rect(11.77, 12.14, 2.23, 2.23, 0.47)],
  cloud: [cloudEye(8.42, 11.42, -4), cloudEye(12.69, 11.12, -4)],
  pill: [moon(7.44, 10.88, 2.05, -3), moon(12.64, 10.61, 2.05, -3)],
  cross: [capsule(8.41, 9.48, 1.67, 3.35, 18), capsule(11.59, 10.52, 1.67, 3.35, 18)],
  flower: [dot(8.42, 10, 1.21), dot(11.58, 10, 1.21)],
  square: [dot(7.4, 9.81, 1.58), dot(12.6, 9.81, 1.58)],
  blob: [moon(7.77, 10.74, 1.86), moon(12.42, 10.74, 1.86)],
}

const n = (value: number) => +value.toFixed(3)

export function roundedRectPath(w: number, h: number, r: number): string {
  const x0 = -w / 2
  const x1 = w / 2
  const y0 = -h / 2
  const y1 = h / 2
  return [
    `M${n(x0 + r)} ${n(y0)}`,
    `L${n(x1 - r)} ${n(y0)}`,
    `A${r} ${r} 0 0 1 ${n(x1)} ${n(y0 + r)}`,
    `L${n(x1)} ${n(y1 - r)}`,
    `A${r} ${r} 0 0 1 ${n(x1 - r)} ${n(y1)}`,
    `L${n(x0 + r)} ${n(y1)}`,
    `A${r} ${r} 0 0 1 ${n(x0)} ${n(y1 - r)}`,
    `L${n(x0)} ${n(y0 + r)}`,
    `A${r} ${r} 0 0 1 ${n(x0 + r)} ${n(y0)}Z`,
  ].join(' ')
}

export function discPath(r: number): string {
  return `M${-r} 0 A${r} ${r} 0 1 1 ${r} 0 A${r} ${r} 0 1 1 ${-r} 0Z`
}

const TRIANGLE_EYE =
  'M0.49 -0.85 L1.09 0.19 A0.57 0.57 0 0 1 0.60 1.05 L-0.60 1.05 A0.57 0.57 0 0 1 -1.09 0.19 L-0.49 -0.85 A0.57 0.57 0 0 1 0.49 -0.85 Z'

/** The eye's own outline around its centre. */
export function eyePath(eye: EyeSpec): string {
  switch (eye.kind) {
    case 'dot':
      return discPath(eye.r)
    case 'rect':
    case 'capsule':
      return roundedRectPath(eye.w, eye.h, eye.r)
    case 'half-moon':
      return `M${-eye.r} 0 A${eye.r} ${eye.r} 0 0 1 ${eye.r} 0 Z`
    case 'triangle':
      return TRIANGLE_EYE
  }
}

export type Point = [number, number]

function arcPoints(from: Point, r: number, large: number, sweep: number, to: Point): Point[] {
  // SVG implementation notes F.6.5 for a circular arc without rotation.
  const dx = (from[0] - to[0]) / 2
  const dy = (from[1] - to[1]) / 2
  const half = Math.hypot(dx, dy)
  const radius = Math.max(r, half)
  const root = Math.sqrt(Math.max(0, radius * radius - half * half)) / (half || 1)
  const sign = large === sweep ? -1 : 1
  const cx = sign * root * dy + (from[0] + to[0]) / 2
  const cy = -sign * root * dx + (from[1] + to[1]) / 2
  const start = Math.atan2(from[1] - cy, from[0] - cx)
  let delta = Math.atan2(to[1] - cy, to[0] - cx) - start
  if (!sweep && delta > 0) delta -= 2 * Math.PI
  if (sweep && delta < 0) delta += 2 * Math.PI
  const steps = Math.max(2, Math.ceil(Math.abs(delta) / (Math.PI / 12)))
  return Array.from({ length: steps }, (_, i) => {
    const angle = start + (delta * (i + 1)) / steps
    return [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)] as Point
  })
}

/** An outline path (M, L, A, Z) flattened to points. */
export function outlinePoints(d: string): Point[] {
  const tokens = d.match(/[MLAZ]|-?\d+(?:\.\d+)?/g) ?? []
  const points: Point[] = []
  let index = 0
  const next = () => Number(tokens[index++])
  while (index < tokens.length) {
    const command = tokens[index++]
    const current = points[points.length - 1] ?? [0, 0]
    if (command === 'M' || command === 'L') {
      points.push([next(), next()])
    } else if (command === 'A') {
      const r = next()
      next()
      next()
      const large = next()
      const sweep = next()
      points.push(...arcPoints(current, r, large, sweep, [next(), next()]))
    }
  }
  return points
}

/** The eye cut flat across at `fraction` of its height from the top (the lid): only the lower part is left. */
export function lidPoints(points: Point[], fraction = 0.48): Point[] {
  const ys = points.map(([, y]) => y)
  const top = Math.min(...ys)
  const cut = top + (Math.max(...ys) - top) * fraction
  const out: Point[] = []
  points.forEach((a, i) => {
    const b = points[(i + 1) % points.length]!
    const aIn = a[1] >= cut
    const bIn = b[1] >= cut
    if (aIn) out.push(a)
    if (aIn !== bIn) out.push([a[0] + ((b[0] - a[0]) * (cut - a[1])) / (b[1] - a[1]), cut])
  })
  return out
}

export function pointsPath(points: Point[]): string {
  return `M${points.map(([x, y]) => `${n(x)} ${n(y)}`).join(' L')} Z`
}

/** The eye's width, for sizing the flat "thinking" line and the round "shocked" eye. */
export function eyeBox(points: Point[]): { w: number; h: number } {
  const xs = points.map(([x]) => x)
  const ys = points.map(([, y]) => y)
  return { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }
}
