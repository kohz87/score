import { expect, test } from 'vitest'
import {
  BIG_STEP,
  GRID,
  clampCoord,
  moveNode,
  placeNewNode,
  snap,
  withLayout,
} from './workflow-layout.ts'
import { addNode, connect, starterDraft, type Draft } from './workflow-model.ts'

const drawn = new Map([
  ['step1', { x: 16, y: 16 }],
  ['end1', { x: 300, y: 16 }],
])

test('snapping rounds to the grid and Alt keeps whole pixels', () => {
  expect(GRID).toBe(16)
  expect(BIG_STEP % GRID).toBe(0)
  expect(snap(23)).toBe(16)
  expect(snap(24)).toBe(32)
  expect(snap(23.4, true)).toBe(23)
  expect(clampCoord(-5)).toBe(0)
  expect(clampCoord(1e9)).toBe(100_000)
})

test('the first move pins every node where it is drawn, later moves change only one', () => {
  const draft = starterDraft('builder')
  expect(draft.layout).toBeUndefined()
  const once = moveNode(draft, drawn, 'end1', { x: 500, y: -20 })
  expect(once.layout?.nodes).toEqual({ step1: { x: 16, y: 16 }, end1: { x: 500, y: 0 } })
  const twice = moveNode(once, new Map(), 'step1', { x: 48, y: 64 })
  expect(twice.layout?.nodes).toEqual({ step1: { x: 48, y: 64 }, end1: { x: 500, y: 0 } })
})

test('an empty layout is removed so the version goes back to auto-arranged', () => {
  const moved = moveNode(starterDraft('builder'), drawn, 'end1', { x: 1, y: 1 })
  expect('layout' in withLayout(moved, undefined)).toBe(false)
  expect('layout' in withLayout(moved, {})).toBe(false)
})

test('a new node in an arranged drawing lands after its source and overlaps nothing; without a layout nothing is pinned', () => {
  const plain = starterDraft('builder')
  const added = addNode(plain, 'gate')
  if ('error' in added) throw new Error(added.error)
  expect(placeNewNode(added.draft, added.id, new Map(), 'step1').layout).toBeUndefined()

  const arranged: Draft = moveNode(plain, drawn, 'end1', { x: 300, y: 16 })
  const gate = addNode(arranged, 'gate')
  if ('error' in gate) throw new Error(gate.error)
  const placed = placeNewNode(gate.draft, gate.id, new Map(), 'step1')
  const at = placed.layout!.nodes[gate.id]!
  expect(at.x % GRID).toBe(0)
  expect(at.x).toBeGreaterThan(16 + 190)
  // The spot after step1 is taken by nothing at x=~300 only if it is clear of end1; it must not overlap it.
  const end = placed.layout!.nodes.end1!
  const overlap = at.x < end.x + 132 && end.x < at.x + 176 && at.y < end.y + 52 && end.y < at.y + 96
  expect(overlap).toBe(false)
  // Without a source it goes below everything.
  const loose = placeNewNode(gate.draft, gate.id, new Map(), null)
  expect(loose.layout!.nodes[gate.id]!.y).toBeGreaterThan(16)
})

test('connecting keeps the layout', () => {
  const moved = moveNode(starterDraft('builder'), drawn, 'end1', { x: 300, y: 80 })
  const added = addNode(moved, 'gate')
  if ('error' in added) throw new Error(added.error)
  const result = connect(added.draft, 'step1', 'failed', added.id)
  expect('draft' in result && result.draft.layout).toEqual(moved.layout)
})

test('S2-010: a step called constructor keeps its drawn position and the layout stays valid', async () => {
  const { WorkflowLayoutSchema } = await import('@score/contract')
  const base = starterDraft('builder')
  const names = ['constructor', 'valueof', 'tostring']
  const draft: Draft = {
    ...base,
    nodes: [
      ...base.nodes,
      ...names.map((id) => ({ ...base.nodes[0]!, id, label: id }) as Draft['nodes'][number]),
    ],
  }
  const current = new Map([
    ['step1', { x: 16, y: 16 }],
    ...names.map((id, index) => [id, { x: 100 + index * 50, y: 200 }] as const),
  ])
  const moved = moveNode(draft, current, 'step1', { x: 48, y: 64 })
  const text = JSON.stringify(moved.layout)
  expect(JSON.parse(text).nodes.constructor).toEqual({ x: 100, y: 200 })
  expect(WorkflowLayoutSchema.safeParse(JSON.parse(text)).success).toBe(true)
  // A saved position for it is also used, not replaced by the drawn one.
  const pinned = moveNode(moved, new Map(), 'constructor', { x: 160, y: 320 })
  expect(pinned.layout?.nodes.constructor).toEqual({ x: 160, y: 320 })
  expect(pinned.layout?.nodes.valueof).toEqual({ x: 150, y: 200 })
  // A new node placed after it starts from its real position.
  const withStep2: Draft = {
    ...pinned,
    nodes: [...pinned.nodes, { ...base.nodes[0]!, id: 'step2' } as Draft['nodes'][number]],
  }
  const added = placeNewNode(withStep2, 'step2', current, 'constructor')
  expect(added.layout?.nodes.step2?.x).toBeGreaterThan(160)
})
