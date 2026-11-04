import { expect, test } from 'vitest'
import { placeNewNode } from './workflow-layout.ts'
import { addNode, starterDraft, type Draft } from './workflow-model.ts'

// The recipe view never reads saved positions; what is left is placing a new step in a draft that still carries them.

const arranged = (): Draft => ({
  ...starterDraft('builder'),
  layout: {
    nodes: {
      step1: { x: 16, y: 16 },
      end1: { x: 300, y: 16 },
    },
  },
})

test('without a saved layout nothing is pinned', () => {
  const plain = starterDraft('builder')
  const added = addNode(plain, 'gate')
  if ('error' in added) throw new Error(added.error)
  expect(placeNewNode(added.draft, added.id, new Map(), 'step1').layout).toBeUndefined()
})

test('a new node in an arranged drawing lands after its source on the grid and overlaps nothing', () => {
  const gate = addNode(arranged(), 'gate')
  if ('error' in gate) throw new Error(gate.error)
  const placed = placeNewNode(gate.draft, gate.id, new Map(), 'step1')
  const at = placed.layout!.nodes[gate.id]!
  expect(at.x % 16).toBe(0)
  expect(at.x).toBeGreaterThan(16 + 190)
  const end = placed.layout!.nodes.end1!
  const overlap = at.x < end.x + 132 && end.x < at.x + 176 && at.y < end.y + 52 && end.y < at.y + 96
  expect(overlap).toBe(false)
  // The saved positions of the others are untouched.
  expect(placed.layout!.nodes.step1).toEqual({ x: 16, y: 16 })
  expect(end).toEqual({ x: 300, y: 16 })
  // Without a source it goes below everything.
  const loose = placeNewNode(gate.draft, gate.id, new Map(), null)
  expect(loose.layout!.nodes[gate.id]!.y).toBeGreaterThan(16)
})

test('S2-010: a step called constructor keeps its saved position and a new step after it starts from there', async () => {
  const { WorkflowLayoutSchema } = await import('@score/contract')
  const base = arranged()
  const draft: Draft = {
    ...base,
    nodes: [
      ...base.nodes,
      { ...base.nodes[0]!, id: 'constructor', label: 'constructor' } as Draft['nodes'][number],
      { ...base.nodes[0]!, id: 'step2' } as Draft['nodes'][number],
    ],
    layout: { nodes: { ...base.layout!.nodes, constructor: { x: 160, y: 320 } } },
  }
  const added = placeNewNode(draft, 'step2', new Map(), 'constructor')
  expect(added.layout?.nodes.step2?.x).toBeGreaterThan(160)
  expect(added.layout?.nodes.constructor).toEqual({ x: 160, y: 320 })
  expect(WorkflowLayoutSchema.safeParse(JSON.parse(JSON.stringify(added.layout))).success).toBe(
    true,
  )
})
