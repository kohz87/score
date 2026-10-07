import type { Shape } from '@score/contract'

export type AgentShapeElement =
  | { tag: 'circle'; cx: number; cy: number; r: number; strokeWidth?: number }
  | { tag: 'rect'; x: number; y: number; width: number; height: number; rx: number }
  | { tag: 'path'; d: string }

export const agentShapes = {
  'circle-dot': [
    { tag: 'circle', cx: 10, cy: 10, r: 6.5, strokeWidth: 2.4 },
    { tag: 'circle', cx: 10, cy: 10, r: 2.4 },
  ],
  triangle: [{ tag: 'path', d: 'M10 3 L17.5 16 H2.5 Z' }],
  diamond: [{ tag: 'path', d: 'M10 2.5 L17.5 10 L10 17.5 L2.5 10 Z' }],
  square: [{ tag: 'rect', x: 4, y: 4, width: 12, height: 12, rx: 4 }],
  hexagon: [{ tag: 'path', d: 'M10 2.5 L17.5 6.25 V13.75 L10 17.5 L2.5 13.75 V6.25 Z' }],
  star: [
    {
      tag: 'path',
      d: 'M10 3 L11.88 7.91 L17.13 8.18 L13.04 11.49 L14.41 16.57 L10 13.7 L5.59 16.57 L6.96 11.49 L2.87 8.18 L8.12 7.91 Z',
    },
  ],
  pill: [
    {
      tag: 'path',
      d: 'M6.5 6 H13.5 A4 4 0 0 1 13.5 14 H6.5 A4 4 0 0 1 6.5 6 Z',
    },
  ],
  cross: [
    {
      tag: 'path',
      d: 'M8 8 V4.5 A2 2 0 0 1 12 4.5 V8 H15.5 A2 2 0 0 1 15.5 12 H12 V15.5 A2 2 0 0 1 8 15.5 V12 H4.5 A2 2 0 0 1 4.5 8 Z',
    },
  ],
} as const satisfies Record<Shape, readonly AgentShapeElement[]>
