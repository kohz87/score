import { OfferedShapes, type Shape } from '@score/contract'

export type AgentShapeElement =
  | { tag: 'circle'; cx: number; cy: number; r: number; strokeWidth?: number }
  | { tag: 'rect'; x: number; y: number; width: number; height: number; rx: number }
  | { tag: 'path'; d: string }

/** One of the nine shapes Score offers and draws (decision 184). */
export type OfferedShape = (typeof OfferedShapes)[number]

const retired: Record<Exclude<Shape, OfferedShape>, OfferedShape> = {
  'circle-dot': 'ball',
  diamond: 'triangle',
  gem: 'triangle',
  hexagon: 'square',
  octagon: 'square',
  shield: 'blob',
  heart: 'blob',
  star: 'flower',
  bolt: 'cross',
  leaf: 'drop',
  moon: 'drop',
  cylinder: 'pill',
  bubble: 'pill',
}

/** Every stored name stays valid; the ones Score no longer offers are drawn as the nearest of the nine. */
export function drawnShape(shape: Shape): OfferedShape {
  return shape in retired ? retired[shape as keyof typeof retired] : (shape as OfferedShape)
}

const names: Record<OfferedShape, string> = {
  ball: 'ball',
  drop: 'drop',
  triangle: 'peak',
  cloud: 'cloud',
  pill: 'pill',
  cross: 'clover',
  flower: 'flower',
  square: 'pebble',
  blob: 'bean',
}

/** The word people see for a shape (of the drawn shape, so a retired name reads as what it looks like now). */
export function shapeName(shape: Shape): string {
  return names[drawnShape(shape)]
}

// Decision 184: nine soft flat bodies in a 20-unit box, fitted inside 1..19; rotations are baked in. The eyes live in
// agent-eyes.ts. agent-shapes.test.ts compares every pair.
export const agentShapes = {
  ball: [{ tag: 'circle', cx: 10, cy: 10, r: 7.07 }],
  drop: [
    {
      tag: 'path',
      d: 'M7.58 2.37 C10.19 4.05 14.65 7.02 15.95 9.81 C17.44 13.16 15.02 17.63 10.37 17.63 C5.72 17.63 2.93 14.46 3.49 10.56 C3.86 7.95 5.72 5.16 7.58 2.37 Z',
    },
  ],
  triangle: [
    {
      tag: 'path',
      d: 'M12.41 6.14 L16.44 13.06 A2.42 2.42 0 0 1 14.35 16.7 L5.65 16.7 A2.42 2.42 0 0 1 3.56 13.06 L7.59 6.14 A2.79 2.79 0 0 1 12.41 6.14 Z',
    },
  ],
  cloud: [
    { tag: 'circle', cx: 6.57, cy: 11.55, r: 3.72 },
    { tag: 'circle', cx: 10.43, cy: 8.11, r: 4.37 },
    { tag: 'circle', cx: 14.58, cy: 10.24, r: 3.53 },
    { tag: 'circle', cx: 12.7, cy: 13.91, r: 3.35 },
    { tag: 'circle', cx: 8.26, cy: 14.41, r: 3.07 },
  ],
  pill: [
    {
      tag: 'path',
      d: 'M7.13 4.94 L12.33 4.66 A5.21 5.21 0 0 1 17.8 9.59 L17.8 9.59 A5.21 5.21 0 0 1 12.87 15.06 L7.67 15.34 A5.21 5.21 0 0 1 2.2 10.41 L2.2 10.41 A5.21 5.21 0 0 1 7.13 4.94 Z',
    },
  ],
  cross: [
    { tag: 'circle', cx: 12.11, cy: 14.15, r: 3.44 },
    { tag: 'circle', cx: 5.85, cy: 12.11, r: 3.44 },
    { tag: 'circle', cx: 7.89, cy: 5.85, r: 3.44 },
    { tag: 'circle', cx: 14.15, cy: 7.89, r: 3.44 },
    { tag: 'circle', cx: 10, cy: 10, r: 3.35 },
  ],
  flower: [
    { tag: 'circle', cx: 10, cy: 4.79, r: 2.79 },
    { tag: 'circle', cx: 14.96, cy: 8.39, r: 2.79 },
    { tag: 'circle', cx: 13.06, cy: 14.21, r: 2.79 },
    { tag: 'circle', cx: 6.94, cy: 14.21, r: 2.79 },
    { tag: 'circle', cx: 5.04, cy: 8.39, r: 2.79 },
    { tag: 'circle', cx: 10, cy: 10, r: 4.09 },
  ],
  square: [{ tag: 'rect', x: 2, y: 2.19, width: 16, height: 15.62, rx: 3.91 }],
  blob: [
    {
      tag: 'path',
      d: 'M5.72 4.42 C8.14 4.05 9.07 6.09 10.37 6.09 C11.67 6.09 12.79 4.05 15.39 4.61 C18 5.26 18.37 9.44 17.44 12.23 C16.32 15.39 13.16 16.7 10 16.7 C6.65 16.7 3.3 15.58 2.37 12.23 C1.54 9.07 2.75 4.88 5.72 4.42 Z',
    },
  ],
} as const satisfies Record<OfferedShape, readonly AgentShapeElement[]>
