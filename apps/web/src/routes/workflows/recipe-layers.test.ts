import type { WorkflowNode } from '@score/contract'
import { expect, test } from 'vitest'
import { releaseDefinition } from '../../../../../e2e/workflow-fixtures.ts'
import { agentMeta, layoutRecipe, placement, usesOf } from './recipe-layers.ts'
import type { Draft } from './workflow-model.ts'

const agent = (id: string, instruction = 'Do it.', extra: Partial<WorkflowNode> = {}) =>
  ({
    id,
    kind: 'agent',
    label: id.toUpperCase(),
    agentId: 'builder',
    instruction,
    retries: 0,
    onFailure: 'fail_run',
    ...extra,
  }) as WorkflowNode
const gate = (id: string): WorkflowNode => ({
  id,
  kind: 'gate',
  label: id,
  question: 'Ok?',
  onReject: 'route',
})
const end = (id: string): WorkflowNode => ({ id, kind: 'end', label: id })
const edge = (from: string, to: string, port = 'ok') => ({
  id: `${from}-${port}-${to}`,
  from,
  port,
  to,
})
const draftOf = (
  nodes: WorkflowNode[],
  edges: Draft['edges'],
  inputs: Draft['inputs'] = [],
): Draft => ({
  name: 'x',
  inputs,
  nodes,
  edges,
})
const ids = (draft: Draft) =>
  layoutRecipe(draft).layers.map((layer) => layer.nodes.map((n) => n.node.id))

test('a straight line is one step per layer, numbered in reading order', () => {
  const draft = draftOf([agent('b'), agent('a'), end('z')], [edge('a', 'b'), edge('b', 'z')])
  const layout = layoutRecipe(draft)
  expect(ids(draft)).toEqual([['a'], ['b'], ['z']])
  expect(layout.stepOf.get('a')).toBe(1)
  expect(layout.stepOf.get('b')).toBe(2)
  expect(layout.stepOf.has('z')).toBe(false)
})

test('steps that lead from the same step share a layer, and a join says both finish, then', () => {
  const draft = draftOf(
    [
      agent('a'),
      agent('b'),
      agent('c'),
      { id: 'j', kind: 'join', label: 'J', mode: 'all' },
      end('z'),
    ],
    [edge('a', 'b'), edge('a', 'c'), edge('b', 'j'), edge('c', 'j'), edge('j', 'z')],
  )
  const layout = layoutRecipe(draft)
  expect(ids(draft)).toEqual([['a'], ['b', 'c'], ['j'], ['z']])
  expect(layout.layers[2]!.joinNote).toBe('both finish, then')
  // A "+" only where one step sits above and one below, so not around the pair.
  expect(layout.layers.map((layer) => layer.insertOn !== null)).toEqual([false, false, false, true])
})

test('a join of three says all 3 finish, then', () => {
  const draft = draftOf(
    [
      agent('a'),
      agent('b'),
      agent('c'),
      agent('d'),
      { id: 'j', kind: 'join', label: 'J', mode: 'all' },
    ],
    [
      edge('a', 'b'),
      edge('a', 'c'),
      edge('a', 'd'),
      edge('b', 'j'),
      edge('c', 'j'),
      edge('d', 'j'),
    ],
  )
  expect(layoutRecipe(draft).layers[2]!.joinNote).toBe('all 3 finish, then')
})

test('the rank is the longest path, so a step that waits on a longer branch sits below it', () => {
  const draft = draftOf(
    [agent('a'), agent('b'), agent('c'), end('z')],
    [edge('a', 'b'), edge('b', 'c'), edge('a', 'c'), edge('c', 'z')],
  )
  expect(ids(draft)).toEqual([['a'], ['b'], ['c'], ['z']])
})

test('a send-back to an earlier step is a marker, not a rank: the layers stay top to bottom', () => {
  const draft = draftOf(
    [agent('a'), gate('g'), agent('c'), end('z')],
    [edge('a', 'g'), edge('g', 'c'), edge('g', 'a', 'rejected'), edge('c', 'z')],
  )
  const layout = layoutRecipe(draft)
  expect(ids(draft)).toEqual([['a'], ['g'], ['c'], ['z']])
  const routes = layout.layers[1]!.nodes[0]!.routes
  expect(routes.find((route) => route.port === 'rejected')!.targets).toEqual([
    { id: 'a', label: 'A', back: true, step: 1 },
  ])
  expect(routes.find((route) => route.port === 'ok')!.targets[0]!.back).toBe(false)
  // The send-back does not count as something that runs before the step.
  expect(placement(draft, layout, 'a').after).toEqual([])
})

test('a loop with no way in still lays out, and a self-loop is a back edge', () => {
  const draft = draftOf(
    [agent('a'), agent('b')],
    [edge('a', 'b'), edge('b', 'a'), edge('b', 'b', 'failed')],
  )
  const layout = layoutRecipe(draft)
  expect(ids(draft)).toEqual([['a'], ['b']])
  const b = layout.layers[1]!.nodes[0]!
  expect(b.routes.flatMap((route) => route.targets).every((target) => target.back)).toBe(true)
})

test('a branch keeps its paths by label and puts each target on its own layer', () => {
  const layout = layoutRecipe(releaseDefinition)
  const branch = layout.layers.flatMap((layer) => layer.nodes).find((n) => n.node.id === 'passed')!
  expect(branch.routes.map((route) => [route.label, route.targets.map((t) => t.id)])).toEqual([
    ['verdict passed', ['publish']],
    ['otherwise', ['repair']],
  ])
  expect(ids(releaseDefinition)).toEqual([
    ['draft'],
    ['review'],
    ['approve'],
    ['passed'],
    ['publish', 'repair'],
    ['repaired'],
  ])
})

test('the saved positions are never read: the same graph lays out the same way', () => {
  const placed: Draft = {
    ...releaseDefinition,
    layout: { nodes: { draft: { x: 900, y: 900 }, publish: { x: 0, y: 0 } } },
  }
  expect(ids(placed)).toEqual(ids(releaseDefinition))
})

test('an empty recipe has no layers, and a lone first step can take a step before it', () => {
  expect(layoutRecipe(draftOf([], [])).layers).toEqual([])
  expect(layoutRecipe(releaseDefinition).insertBeforeFirst).toBe('draft')
  const two = draftOf([agent('a'), agent('b')], [])
  expect(layoutRecipe(two).insertBeforeFirst).toBeNull()
})

test('uses reads inputs by label and earlier steps by number; meta says retries and what a failure does', () => {
  const draft = draftOf(
    [
      agent('a'),
      agent('b', 'Review {{nodes.a.output}} about {{inputs.topic}} and {{ inputs.topic }}', {
        retries: 2,
        onFailure: 'route',
      }),
      agent('c'),
    ],
    [edge('a', 'b'), edge('b', 'c'), edge('b', 'c', 'failed')],
    [{ name: 'topic', label: 'What changed', required: true, maxChars: 100 }],
  )
  const layout = layoutRecipe(draft)
  const b = draft.nodes[1] as Extract<WorkflowNode, { kind: 'agent' }>
  expect(usesOf(b, draft, layout.stepOf)).toEqual(['step 1', 'What changed'])
  const failed = layout.layers[1]!.nodes[0]!.routes.find(
    (route) => route.port === 'failed',
  )!.targets
  expect(agentMeta(b, draft, layout, failed)).toBe(
    'Uses: step 1, What changed · 2 retries · on failure: go to step 3',
  )
  expect(agentMeta(draft.nodes[0] as typeof b, draft, layout, [])).toBe(
    'no retry · on failure: stop the run',
  )
})

test('placement says what a step runs after and what runs beside it', () => {
  const draft = draftOf([agent('a'), agent('b'), agent('c')], [edge('a', 'b'), edge('a', 'c')])
  const layout = layoutRecipe(draft)
  expect(placement(draft, layout, 'b')).toEqual({ after: ['step 1'], beside: ['step 3'] })
  expect(placement(draft, layout, 'a')).toEqual({ after: [], beside: [] })
})
