import { NodeStateSchema, type TokenKind, type WorkflowEvent } from '@score/contract'
import { expect, test } from 'vitest'
import {
  buildWorkflowGraph,
  describeWorkflowEvents,
  edgeIndex,
  edgeStatesOf,
  filterWorkflowLog,
  nodeVisual,
  outcomeLines,
  workflowEventEffect,
  workflowReplayAt,
} from './workflow-run-model.ts'

const definition = {
  nodes: [
    {
      id: 'a',
      kind: 'agent',
      label: 'Draft',
      agentId: 'builder',
      instruction: 'x',
      retries: 0,
      onFailure: 'route',
    },
    { id: 'g', kind: 'gate', label: 'Approve', question: 'ok?', onReject: 'route' },
    {
      id: 'b',
      kind: 'branch',
      label: 'Passed?',
      subject: 'a',
      rules: [{ id: 'r1', when: { kind: 'verdict', is: 'passed' } }],
    },
    {
      id: 'fix',
      kind: 'agent',
      label: 'Repair',
      agentId: 'reviewer',
      instruction: 'y',
      retries: 0,
      onFailure: 'fail_run',
    },
    { id: 'end', kind: 'end', label: 'Done' },
  ],
  edges: [
    { id: 'e1', from: 'a', port: 'ok', to: 'g' },
    { id: 'e2', from: 'a', port: 'failed', to: 'fix' },
    { id: 'e3', from: 'g', port: 'ok', to: 'b' },
    { id: 'e4', from: 'g', port: 'rejected', to: 'fix' },
    { id: 'e5', from: 'b', port: 'r1', to: 'end' },
    { id: 'e6', from: 'b', port: 'default', to: 'fix' },
  ],
} as const

test('every node state has a look, and a gate that waits for the person is the "needs you" one', () => {
  for (const state of NodeStateSchema.options) expect(nodeVisual(state)).toBeTruthy()
  expect(nodeVisual('gate_open')).toBe('gate')
  expect(nodeVisual('unresolved')).toBe('abandoned')
  expect(nodeVisual('skipped')).toBe('skipped')
})

test('the graph is the definition: shapes by kind, and port words on the edges that need them', () => {
  const { nodes, edges } = buildWorkflowGraph(definition as never)
  expect(nodes.map((n) => [n.id, n.shape])).toEqual([
    ['a', 'agent'],
    ['g', 'gate'],
    ['b', 'branch'],
    ['fix', 'agent'],
    ['end', 'end'],
  ])
  expect(nodes[0]).toMatchObject({ agentId: 'builder', title: 'Draft' })
  expect(nodes[1]).toMatchObject({ agentId: '' })
  const byId = Object.fromEntries(edges.map((e) => [e.id, e]))
  expect(byId.e1).toMatchObject({ kind: 'ok' })
  expect(byId.e1!.label).toBeUndefined()
  expect(byId.e2).toMatchObject({ kind: 'failed', label: 'if it fails' })
  expect(byId.e3).toMatchObject({ kind: 'ok', label: 'approved' })
  expect(byId.e4).toMatchObject({ kind: 'rejected', label: 'rejected' })
  expect(byId.e5).toMatchObject({ kind: 'branch', label: 'verdict passed' })
  expect(byId.e6).toMatchObject({ kind: 'default', label: 'otherwise' })
})

test('tokens say which edges were taken and which were passed over; start tokens belong to no edge', () => {
  const states = edgeStatesOf([
    { edgeId: 'start:a', kind: 'ok' },
    { edgeId: 'e1', kind: 'ok' },
    { edgeId: 'e2', kind: 'skip' },
    { edgeId: 'e5', kind: 'branch' },
  ])
  expect([...states]).toEqual([
    ['e1', 'taken'],
    ['e2', 'skipped'],
    ['e5', 'taken'],
  ])
})

const ev = (id: string, patch: Partial<WorkflowEvent>): WorkflowEvent => ({
  id,
  at: '2026-10-10T10:00:00.000Z',
  kind: 'node_state',
  stepId: null,
  attemptId: null,
  tool: null,
  verdict: null,
  code: null,
  summary: '',
  nodeId: null,
  edgeId: null,
  ...patch,
})
const edges = edgeIndex(definition as never)
const kinds = new Map<string, TokenKind>([
  ['e1', 'ok'],
  ['e2', 'failed'],
  ['e6', 'skip'],
])
const nodeIds = new Set(definition.nodes.map((n) => n.id))

test('a dot travels only along an edge a token travelled; a skipped edge and an unknown edge move nothing', () => {
  expect(
    workflowEventEffect(ev('1', { kind: 'token', edgeId: 'e1' }), edges, kinds, nodeIds),
  ).toEqual({
    eventId: '1',
    edge: 'e1',
    kind: 'dot',
    from: 'a',
    to: 'g',
    tone: 'ok',
  })
  expect(
    workflowEventEffect(ev('2', { kind: 'token', edgeId: 'e2' }), edges, kinds, nodeIds),
  ).toMatchObject({
    tone: 'fail',
  })
  expect(
    workflowEventEffect(ev('3', { kind: 'token', edgeId: 'e6' }), edges, kinds, nodeIds),
  ).toBeNull()
  expect(
    workflowEventEffect(ev('4', { kind: 'token', edgeId: 'nope' }), edges, kinds, nodeIds),
  ).toBeNull()
  expect(
    workflowEventEffect(ev('5', { kind: 'token', edgeId: 'start:a' }), edges, kinds, nodeIds),
  ).toMatchObject({
    kind: 'pulse',
    to: 'a',
  })
})

test('node states light the node: needs-you amber, failure red, nothing for passive states', () => {
  const effect = (state: string) =>
    workflowEventEffect(ev('x', { nodeId: 'g', verdict: state }), edges, kinds, nodeIds)
  expect(effect('gate_open')).toMatchObject({ kind: 'pulse', tone: 'need', to: 'g' })
  expect(effect('failed')).toMatchObject({ tone: 'fail' })
  expect(effect('running')).toMatchObject({ tone: 'ok' })
  expect(effect('skipped')).toBeNull()
  expect(effect('waiting')).toBeNull()
  expect(
    workflowEventEffect(ev('y', { nodeId: 'ghost', verdict: 'running' }), edges, kinds, nodeIds),
  ).toBeNull()
})

test('replay folds the events seen so far: every node waits at first, states and tokens follow', () => {
  const events = [
    ev('1', { nodeId: 'a', verdict: 'running' }),
    ev('2', { nodeId: 'a', verdict: 'succeeded' }),
    ev('3', { kind: 'token', edgeId: 'e1' }),
    ev('4', { kind: 'token', edgeId: 'e6' }),
    ev('5', { nodeId: 'fix', verdict: 'skipped' }),
  ]
  const ids = definition.nodes.map((n) => n.id)
  const start = workflowReplayAt(events, 0, ids, kinds)
  expect([...start.nodes.values()].every((v) => v === 'waiting')).toBe(true)
  expect(start.edges.size).toBe(0)
  const mid = workflowReplayAt(events, 3, ids, kinds)
  expect(mid.nodes.get('a')).toBe('succeeded')
  expect(mid.edges.get('e1')).toBe('taken')
  const end = workflowReplayAt(events, 99, ids, kinds)
  expect(end.shown).toBe(5)
  expect(end.edges.get('e6')).toBe('skipped')
  expect(end.nodes.get('fix')).toBe('skipped')
})

test('the log of a node is the events that name it', () => {
  const list = [ev('1', { nodeId: 'a' }), ev('2', { nodeId: 'g' }), ev('3', {})]
  expect(filterWorkflowLog(list, null)).toHaveLength(3)
  expect(filterWorkflowLog(list, 'g').map((e) => e.id)).toEqual(['2'])
})

test('the outcome is two statements: the graph, and the note that qualifies it', () => {
  expect(outcomeLines({ graphOutcome: null, outcomeNote: null })).toEqual({
    graph: null,
    note: null,
  })
  expect(
    outcomeLines({
      graphOutcome: 'reached_end',
      outcomeNote: 'Graph reached the end — 1 abandoned attempt not confirmed ended',
    }),
  ).toEqual({
    graph: 'Workflow reached its end',
    note: 'Graph reached the end — 1 abandoned attempt not confirmed ended',
  })
  expect(outcomeLines({ graphOutcome: 'stopped', outcomeNote: null }).graph).toBe(
    'Workflow stopped',
  )
})

test('the log speaks in titles and plain words, never ids, states or internal summaries', () => {
  const run = {
    definition,
    tokens: [
      { edgeId: 'e1', kind: 'ok' },
      { edgeId: 'e2', kind: 'failed' },
      { edgeId: 'e5', kind: 'branch' },
      { edgeId: 'e6', kind: 'skip' },
      { edgeId: 'start:a', kind: 'ok' },
    ],
  } as never
  const events = [
    ev('1', { kind: 'run_started', summary: 'created' }),
    ev('2', { kind: 'token', edgeId: 'start:a', summary: 'token ok on start:a' }),
    ev('3', { nodeId: 'a', verdict: 'running', summary: 'a: running' }),
    ev('4', { nodeId: 'a', verdict: 'succeeded', summary: 'a: succeeded' }),
    ev('5', { kind: 'token', edgeId: 'e1', nodeId: 'a', summary: 'token ok on e1' }),
    ev('6', {
      nodeId: 'g',
      verdict: 'gate_open',
      summary: 'g: gate_open (waiting for your decision)',
    }),
    ev('7', { kind: 'gate_decided', nodeId: 'g', summary: 'wf gate decided' }),
    ev('8', { nodeId: 'b', verdict: 'succeeded', summary: 'b: succeeded (matched r1)' }),
    ev('9', { kind: 'token', edgeId: 'e5', nodeId: 'b', summary: 'token branch on e5' }),
    ev('10', { kind: 'token', edgeId: 'e6', nodeId: 'b', summary: 'token skip on e6' }),
    ev('11', { nodeId: 'fix', verdict: 'skipped', summary: 'fix: skipped (no path led here)' }),
    ev('12', { kind: 'token', edgeId: 'e2', nodeId: 'a', summary: 'token failed on e2' }),
    ev('13', { nodeId: 'a', verdict: 'failed', summary: 'a: failed (the step failed)' }),
    ev('14', { nodeId: 'end', verdict: 'succeeded', summary: 'end: succeeded' }),
    ev('15', { kind: 'control', summary: 'ended' }),
  ]
  const lines = describeWorkflowEvents(events, run, (id) => id).map((l) => l.summary)
  expect(lines).toEqual([
    'Run started',
    'Draft started (builder)',
    'Draft finished',
    'Draft → Approve',
    'Approve is waiting for you',
    'You approved Approve',
    "Passed? took 'verdict passed' → Done",
    'Repair was skipped',
    'Draft failed → Repair',
    'Draft failed: the step failed',
    'The run reached Done',
    'The run ended',
  ])
  for (const text of lines) expect(text).not.toMatch(/\b(e\d|start:|gate_open|token|node_state)\b/)
})
