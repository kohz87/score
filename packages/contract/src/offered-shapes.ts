import type { Shape } from './types.ts'
/**
 * Decision 184 (owner, 2026-11-10): the nine shapes Score offers and draws, each with its own eyes. Every name in
 * ShapeSchema stays valid (stored styles and API bodies are unchanged); a name outside this list is drawn as the
 * nearest of these nine.
 */
export const OfferedShapes = [
  'ball',
  'drop',
  'triangle',
  'cloud',
  'pill',
  'cross',
  'flower',
  'square',
  'blob',
] as const satisfies readonly Shape[]
