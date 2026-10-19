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
  // PLAN 10.2: twelve more silhouettes (owner-approved preview geometry), each its own outline at 18px;
  // agent-shapes.test.ts compares every pair.
  cloud: [
    {
      tag: 'path',
      d: 'M5.8 15.5 A3.3 3.3 0 0 1 5.3 9 A4.6 4.6 0 0 1 14 7.4 A4 4 0 0 1 14.6 15.5 Z',
    },
  ],
  cylinder: [{ tag: 'path', d: 'M5 5.2 A5 2.3 0 0 1 15 5.2 V14.8 A5 2.3 0 0 1 5 14.8 Z' }],
  heart: [
    {
      tag: 'path',
      d: 'M10 16.6 C4 12.6 2.5 9.6 3.6 7.1 C4.8 4.4 8.4 4.2 10 6.8 C11.6 4.2 15.2 4.4 16.4 7.1 C17.5 9.6 16 12.6 10 16.6 Z',
    },
  ],
  drop: [
    {
      tag: 'path',
      d: 'M10 2.6 C13.2 6.8 15.3 9.4 15.3 12.2 A5.3 5.3 0 0 1 4.7 12.2 C4.7 9.4 6.8 6.8 10 2.6 Z',
    },
  ],
  bolt: [{ tag: 'path', d: 'M12 2.4 L4.4 11.2 H9.2 L8 17.6 L15.6 8.8 H10.8 Z' }],
  moon: [{ tag: 'path', d: 'M12.8 3.2 A7 7 0 1 0 16.8 12.6 A5.6 5.6 0 0 1 12.8 3.2 Z' }],
  leaf: [{ tag: 'path', d: 'M3.6 16.4 C3.6 8.2 8.8 3.4 16.6 3.4 C16.6 11.2 11.8 16.4 3.6 16.4 Z' }],
  blob: [
    {
      tag: 'path',
      d: 'M7 3.2 C10.4 1.6 16 3.4 16.4 7.6 C16.6 10.4 14.8 11.2 15.8 13.6 C16.6 16 13.2 17.8 10 16.8 C8.2 16.2 6.8 13.8 4.8 14.8 C2.4 16 1.6 12.4 2.4 10 C3 8 2 6.4 3.6 5 C4.6 4 5.8 3.6 7 3.2 Z',
    },
  ],
  shield: [
    {
      tag: 'path',
      d: 'M10 2.4 L16.6 4.5 V8.2 C16.6 12.8 13.4 15.8 10 17.8 C6.6 15.8 3.4 12.8 3.4 8.2 V4.5 Z',
    },
  ],
  octagon: [{ tag: 'path', d: 'M4 2 H16 L18 4 V16 L16 18 H4 L2 16 V4 Z' }],
  bubble: [
    {
      tag: 'path',
      d: 'M5 3.6 H15 A2.6 2.6 0 0 1 17.6 6.2 V11.4 A2.6 2.6 0 0 1 15 14 H9.2 L5.6 17.2 V14 H5 A2.6 2.6 0 0 1 2.4 11.4 V6.2 A2.6 2.6 0 0 1 5 3.6 Z',
    },
  ],
  gem: [{ tag: 'path', d: 'M6 3.4 H14 L17.6 8 L10 17.2 L2.4 8 Z' }],
} as const satisfies Record<Shape, readonly AgentShapeElement[]>

/**
 * What a bot is drawn with: the plain shapes, except the lead's ring-and-dot, which becomes a solid round head (a ring
 * can't carry a face, and no other shape is round). The plain list stays the list-size (xs) look.
 */
export const botBodies = {
  ...agentShapes,
  'circle-dot': [{ tag: 'circle', cx: 10, cy: 10, r: 8 }],
} as const satisfies Record<Shape, readonly AgentShapeElement[]>

/** The eyes of a shape, in its 20-unit box: centre line `y`, the two centres, and each eye's width and height. */
export type AgentEyes = { y: number; xs: readonly [number, number]; w: number; h: number }

export const agentEyes = {
  'circle-dot': { y: 9.6, xs: [7.7, 12.3], w: 1.6, h: 2.8 },
  triangle: { y: 12.1, xs: [8.6, 11.4], w: 1.4, h: 2.4 },
  diamond: { y: 9.8, xs: [8.3, 11.7], w: 1.4, h: 2.5 },
  square: { y: 9.8, xs: [8.1, 11.9], w: 1.5, h: 2.7 },
  hexagon: { y: 9.8, xs: [8.1, 11.9], w: 1.5, h: 2.7 },
  star: { y: 10.4, xs: [9, 11], w: 1.1, h: 1.9 },
  pill: { y: 10, xs: [8.2, 11.8], w: 1.4, h: 2.4 },
  cross: { y: 10, xs: [8.9, 11.1], w: 1.1, h: 2 },
  cloud: { y: 11.6, xs: [8.4, 11.9], w: 1.4, h: 2.4 },
  cylinder: { y: 10.6, xs: [8.2, 11.8], w: 1.5, h: 2.6 },
  heart: { y: 9.8, xs: [8, 12], w: 1.4, h: 2.4 },
  drop: { y: 12, xs: [8.3, 11.7], w: 1.4, h: 2.4 },
  bolt: { y: 10.1, xs: [9.3, 11.1], w: 1, h: 1.8 },
  moon: { y: 10.2, xs: [6.6, 9.2], w: 1.3, h: 2.2 },
  leaf: { y: 10.9, xs: [8.9, 11.7], w: 1.3, h: 2.2 },
  blob: { y: 9.8, xs: [8, 11.6], w: 1.5, h: 2.6 },
  shield: { y: 9, xs: [8.2, 11.8], w: 1.5, h: 2.6 },
  octagon: { y: 9.8, xs: [8.2, 11.8], w: 1.5, h: 2.7 },
  bubble: { y: 8.8, xs: [8.2, 11.8], w: 1.5, h: 2.6 },
  gem: { y: 8.6, xs: [8.4, 11.6], w: 1.3, h: 2.2 },
} as const satisfies Record<Shape, AgentEyes>

/** Fine lines drawn over a bot's body (the cylinder's lid, the gem's facets): a white wash, never part of the silhouette. */
export const botDetails: Partial<Record<Shape, readonly string[]>> = {
  cylinder: ['M5 5.2 A5 2.3 0 0 0 15 5.2'],
  gem: ['M2.4 8 H17.6', 'M7.6 3.4 L6.4 8 L10 17.2', 'M12.4 3.4 L13.6 8 L10 17.2'],
}
