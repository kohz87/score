import type { GraphNode } from './orch-model.ts'
import { visualLabel, type EffectTone, type NodeVisual } from './orch-model.ts'

export const NODE_W = 196
export const NODE_H = 68

/** Workflow nodes (7.1b) keep the agent card's size; the local nodes are smaller and shaped for what they are. */
export const nodeSize = (node: Pick<GraphNode, 'shape'>): { w: number; h: number } => {
  switch (node.shape) {
    case 'gate':
      return { w: 176, h: 96 }
    case 'branch':
      return { w: 176, h: 76 }
    case 'join':
    case 'end':
      return { w: 132, h: 52 }
    default:
      return { w: NODE_W, h: NODE_H }
  }
}

export const toneClass = (tone: EffectTone) => `orch-tone--${tone}`

/** The word under a workflow node's title: a gate is approved, not "succeeded". */
export function shapedWord(shape: NonNullable<GraphNode['shape']>, visual: NodeVisual): string {
  if (shape === 'gate') {
    if (visual === 'succeeded') return 'approved'
    if (visual === 'failed') return 'rejected'
  }
  if (shape === 'end' && visual === 'succeeded') return 'reached'
  if ((shape === 'branch' || shape === 'join') && visual === 'succeeded') return 'passed on'
  return visualLabel[visual]
}
