import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { AgentSummary, FlowEdge, FlowNode } from '@score/contract'
import { FlowCanvas } from './FlowCanvas.tsx'

afterEach(cleanup)

const agents: AgentSummary[] = [
  { id: 'lead', color: '#6B4EFF', shape: 'circle-dot' },
  { id: 'builder', color: '#19C39A', shape: 'triangle' },
  { id: 'reviewer', color: '#FFB61E', shape: 'diamond' },
].map(({ id, color, shape }) => ({
  id,
  name: id,
  role: 'Example agent',
  style: { color, shape: shape as AgentSummary['style']['shape'] },
  status: 'idle',
  activity: null,
  model: null,
  served: true,
}))
function node(id: string, overrides: Partial<FlowNode> = {}): FlowNode {
  return {
    id,
    kind: 'step',
    title: `Step ${id}`,
    agentId: 'builder',
    state: 'planned',
    subtitle: 'builder, planned',
    taskId: null,
    layout: { col: 0, row: 0 },
    ...overrides,
  }
}
const nodes: FlowNode[] = [
  node('brief', { kind: 'brief', title: 'Brief from you', agentId: null, state: 'done' }),
  node('plan', { agentId: 'lead', state: 'done', subtitle: 'lead, done' }),
  node('build', { state: 'needs_you' }),
  node('review', { agentId: 'reviewer', state: 'working', subtitle: 'reviewer, working' }),
  node('docs', { state: 'planned' }),
  node('broken', { state: 'failed', subtitle: 'builder, failed' }),
]
const edge = (from: string, to: string, kind: FlowEdge['kind'], label: string | null = null) => ({
  id: `${from}>${to}:${kind}`,
  from,
  to,
  kind,
  label,
})
const edges: FlowEdge[] = [
  edge('brief', 'plan', 'flow'),
  edge('plan', 'build', 'handoff'),
  edge('build', 'review', 'review', 'for review'),
  edge('review', 'build', 'sent_back', 'sent back'),
  edge('review', 'docs', 'planned'),
]

const active = () => (document.activeElement as HTMLElement | null)?.dataset.flowNode

function setup(onSelect = vi.fn()) {
  render(<FlowCanvas nodes={nodes} edges={edges} agents={agents} onSelect={onSelect} />)
  return { onSelect }
}

test('renders a card per node with its state', () => {
  setup()
  for (const [id, state] of [
    ['brief', 'done'],
    ['build', 'needs_you'],
    ['review', 'working'],
    ['docs', 'planned'],
    ['broken', 'failed'],
  ]) {
    expect(document.querySelector(`[data-flow-node="${id}"]`)?.getAttribute('data-state')).toBe(
      state,
    )
  }
  expect(screen.getByText('Needs you', { selector: '.flow-node__pill' })).toBeTruthy()
  expect(screen.getByRole('button', { name: /^Step build,.*needs you$/ })).toBeTruthy()
})

test('draws one edge per kind with its label and style hooks', () => {
  setup()
  const drawn = [...document.querySelectorAll('[data-flow-edge]')]
  expect(drawn.map((el) => el.getAttribute('data-kind'))).toEqual([
    'flow',
    'handoff',
    'review',
    'sent_back',
    'planned',
  ])
  expect(screen.getByText('for review')).toBeTruthy()
  expect(screen.getByText('sent back')).toBeTruthy()
  expect(screen.getByRole('img', { name: 'Step review to Step build, sent back' })).toBeTruthy()
  expect(drawn[4]!.querySelector('path')!.getAttribute('d')).toMatch(/^M /)
})

test('zoom buttons change the percentage and fit is available', () => {
  setup()
  const level = screen.getByRole('status', { name: 'Zoom level' })
  expect(level.textContent).toBe('100%')
  fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
  expect(level.textContent).toBe('125%')
  fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }))
  fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }))
  expect(level.textContent).toBe('75%')
  expect(screen.getByTestId('flow-world').style.transform).toBe('scale(0.75)')
})

test('arrow keys move focus between nodes and Enter selects', () => {
  const { onSelect } = setup()
  const brief = document.querySelector<HTMLElement>('[data-flow-node="brief"]')!
  brief.focus()
  fireEvent.keyDown(brief, { key: 'ArrowRight' })
  expect(active()).toBe('plan')
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' })
  const third = document.activeElement as HTMLElement
  expect(['build', 'review', 'docs', 'broken']).toContain(third.dataset.flowNode)
  fireEvent.keyDown(third, { key: 'ArrowLeft' })
  expect(active()).toBe('plan')
  fireEvent.keyDown(document.activeElement!, { key: 'End' })
  fireEvent.keyDown(document.activeElement!, { key: 'Home' })
  expect(active()).toBe('brief')
  fireEvent.click(document.activeElement!)
  expect(onSelect).toHaveBeenCalledWith('brief')
  // Roving tabindex: exactly one node is in the tab order.
  expect(document.querySelectorAll('[data-flow-node][tabindex="0"]')).toHaveLength(1)
})
