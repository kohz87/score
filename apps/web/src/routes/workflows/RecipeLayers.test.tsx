import type { AgentSummary, WorkflowNode } from '@score/contract'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { RecipeLayers, type CardState, type InsertStep } from './RecipeLayers.tsx'
import type { Draft } from './workflow-model.ts'
import { indexIssues } from './workflow-validation.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const agents = [
  { id: 'builder', name: 'builder', style: { color: '#19C39A', shape: 'square' } },
  { id: 'reviewer', name: 'reviewer', style: { color: '#FFB61E', shape: 'triangle' } },
] as unknown as AgentSummary[]

const step = (
  id: string,
  label: string,
  agentId: string,
  instruction = 'Do it.',
): WorkflowNode => ({
  id,
  kind: 'agent',
  label,
  agentId,
  instruction,
  retries: 1,
  onFailure: 'fail_run',
})

// input → write → (review beside shots) → both finish → approve (send back to write) → notes → done
const draft: Draft = {
  name: 'Review and ship',
  inputs: [{ name: 'what', label: 'what changed', required: true, maxChars: 200 }],
  nodes: [
    step('write', 'Write the change', 'builder', 'Change {{inputs.what}}'),
    step('review', 'Review the diff', 'reviewer', 'Review {{nodes.write.output}}'),
    step('shots', 'Screenshots of the change', 'builder'),
    { id: 'both', kind: 'join', label: 'Both done', mode: 'all' },
    {
      id: 'ok',
      kind: 'gate',
      label: 'You look at the review',
      question: 'Is it good?',
      onReject: 'route',
    },
    step('notes', 'Write the release notes', 'builder'),
    { id: 'done', kind: 'end', label: 'Done' },
  ],
  edges: [
    { id: 'e1', from: 'write', port: 'ok', to: 'review' },
    { id: 'e2', from: 'write', port: 'ok', to: 'shots' },
    { id: 'e3', from: 'review', port: 'ok', to: 'both' },
    { id: 'e4', from: 'shots', port: 'ok', to: 'both' },
    { id: 'e5', from: 'both', port: 'ok', to: 'ok' },
    { id: 'e6', from: 'ok', port: 'ok', to: 'notes' },
    { id: 'e7', from: 'ok', port: 'rejected', to: 'write' },
    { id: 'e8', from: 'notes', port: 'ok', to: 'done' },
  ],
}

function mount(props: Partial<Parameters<typeof RecipeLayers>[0]> = {}) {
  const onSelect = vi.fn()
  const onInsert = vi.fn<InsertStep>()
  const onDeleteNode = vi.fn()
  render(
    <RecipeLayers
      draft={draft}
      agents={agents}
      issues={indexIssues([])}
      selected={null}
      onSelect={onSelect}
      onInsert={onInsert}
      onDeleteNode={onDeleteNode}
      {...props}
    />,
  )
  return { onSelect, onInsert, onDeleteNode }
}

test('draws the input, numbered agent steps with their glyph word, and the line under each title', () => {
  mount()
  const graph = screen.getByRole('region', { name: 'Recipe graph' })
  expect(within(graph).getByText('You · input')).toBeTruthy()
  expect(within(graph).getAllByText(/what changed/).length).toBeGreaterThan(0)
  expect(within(graph).getByText(/text, required/)).toBeTruthy()
  const write = screen.getByRole('button', { name: /Agent step Write the change, builder/ })
  expect(within(write).getByText('Step 1 · builder')).toBeTruthy()
  expect(
    within(write).getByText('Uses: what changed · 1 retry · on failure: stop the run'),
  ).toBeTruthy()
  const review = screen.getByRole('button', { name: /Agent step Review the diff, reviewer/ })
  expect(within(review).getByText('Step 2 · reviewer')).toBeTruthy()
  expect(within(review).getByText(/Uses: step 1 ·/)).toBeTruthy()
  // Done is a pill that says what it does.
  expect(screen.getByRole('button', { name: 'End Done' }).textContent).toContain('finishes the run')
})

test('steps that run together sit in one row, with a bracket note, and the join says both finish, then', () => {
  mount()
  const row = document.querySelector('.rl-row')!
  expect(
    [...row.querySelectorAll('[data-node]')].map((el) => (el as HTMLElement).dataset.node),
  ).toEqual(['review', 'shots'])
  expect(screen.getByText('at the same time')).toBeTruthy()
  expect(screen.getByText('both finish, then')).toBeTruthy()
})

test('the approval is the light card with its ways on, and a send-back reads as a return to the step above', () => {
  mount()
  const gate = screen.getByRole('button', { name: /Gate You look at the review/ })
  expect(gate.getAttribute('data-kind')).toBe('gate')
  expect(within(gate).getByText('You · approval')).toBeTruthy()
  expect(
    within(gate).getByText('Approve → Write the release notes · Send back → ↩ step 1'),
  ).toBeTruthy()
})

test('a loop on a step is a marker on its card, not a line', () => {
  const looped: Draft = {
    ...draft,
    edges: [...draft.edges, { id: 'e9', from: 'notes', port: 'failed', to: 'write' }],
  }
  mount({ draft: looped })
  const notes = screen.getByRole('button', { name: /Agent step Write the release notes/ })
  expect(within(notes).getByText('↩ back to step 1 (when it fails)')).toBeTruthy()
})

test('a branch card lists each path by its label', () => {
  const branching: Draft = {
    ...draft,
    nodes: [
      ...draft.nodes,
      {
        id: 'pick',
        kind: 'branch',
        label: 'Passed?',
        subject: 'review',
        rules: [{ id: 'r1', when: { kind: 'verdict', is: 'passed' } }],
      },
    ],
    edges: [
      ...draft.edges,
      { id: 'e10', from: 'notes', port: 'ok', to: 'pick' },
      { id: 'e11', from: 'pick', port: 'r1', to: 'done' },
    ],
  }
  mount({ draft: branching })
  const paths = within(screen.getByRole('button', { name: /Branch Passed\?/ })).getByRole('list', {
    name: 'Paths',
  })
  const rows = within(paths)
    .getAllByRole('listitem')
    .map((row) => row.textContent)
  expect(rows).toEqual(['verdict passed→Done', 'otherwise→nothing yet'])
})

test('clicking a card selects it, clicking it again lets go; the selected card is pressed', () => {
  const { onSelect } = mount({ selected: 'review' })
  const review = screen.getByRole('button', { name: /Agent step Review the diff/ })
  expect(review.getAttribute('aria-pressed')).toBe('true')
  fireEvent.click(review)
  expect(onSelect).toHaveBeenLastCalledWith(null)
  fireEvent.click(screen.getByRole('button', { name: /Agent step Write the change/ }))
  expect(onSelect).toHaveBeenLastCalledWith('write')
})

test('a + on a connection offers the agents and the flow steps (never Done) and inserts there', () => {
  const { onInsert } = mount()
  // One step above and one below only: input → write has the "before the first step" +, and the notes line has one.
  fireEvent.click(screen.getByRole('button', { name: 'Add a step after the input' }))
  const menu = screen.getByRole('menu', { name: 'Add a step after the input' })
  expect(
    within(menu)
      .getAllByRole('menuitem')
      .map((b) => b.getAttribute('aria-label')),
  ).toEqual([
    'Add an agent step for builder',
    'Add an agent step for reviewer',
    'Add a gate',
    'Add a branch',
    'Add a join',
  ])
  fireEvent.click(within(menu).getByRole('menuitem', { name: 'Add an agent step for reviewer' }))
  expect(onInsert).toHaveBeenCalledWith({ before: 'write' }, 'agent', 'reviewer', 'reviewer')
  expect(screen.queryByRole('menu', { name: 'Add a step after the input' })).toBeNull()

  fireEvent.click(screen.getByRole('button', { name: 'Add a step after You look at the review' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Add a branch' }))
  expect(onInsert).toHaveBeenLastCalledWith({ edgeId: 'e6' }, 'branch', '', '')
})

test('Escape closes the add menu without adding', () => {
  const { onInsert } = mount()
  fireEvent.click(screen.getByRole('button', { name: 'Add a step after the input' }))
  fireEvent.keyDown(screen.getByRole('menu', { name: 'Add a step after the input' }), {
    key: 'Escape',
  })
  expect(screen.queryByRole('menu', { name: 'Add a step after the input' })).toBeNull()
  expect(onInsert).not.toHaveBeenCalled()
})

test('Delete on a card asks, and only a yes passes it on', () => {
  const { onDeleteNode } = mount()
  const card = screen.getByRole('button', { name: /Agent step Review the diff/ })
  const ask = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true)
  fireEvent.keyDown(card, { key: 'Delete' })
  expect(onDeleteNode).not.toHaveBeenCalled()
  fireEvent.keyDown(card, { key: 'Backspace' })
  expect(onDeleteNode).toHaveBeenCalledWith('review')
  expect(ask.mock.calls[0]![0]).toMatch(/Review the diff/)
})

test('read-only keeps selection but offers no +, and Delete does nothing', () => {
  const { onSelect, onDeleteNode } = mount({ readOnly: true })
  expect(screen.queryByRole('button', { name: /^Add a step/ })).toBeNull()
  const card = screen.getByRole('button', { name: /Agent step Review the diff/ })
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  fireEvent.keyDown(card, { key: 'Delete' })
  expect(onDeleteNode).not.toHaveBeenCalled()
  fireEvent.click(card)
  expect(onSelect).toHaveBeenCalledWith('review')
})

test('states from a run or a preview show on each card, in words, and a gate that waits says Needs you', () => {
  const states = new Map<string, CardState>([
    ['write', { visual: 'succeeded' }],
    ['review', { visual: 'running', status: 'Previewing…' }],
    ['ok', { visual: 'gate' }],
  ])
  mount({ states })
  const write = screen.getByRole('button', { name: /Agent step Write the change.*succeeded/ })
  expect(write.getAttribute('data-state')).toBe('succeeded')
  const review = screen.getByRole('button', {
    name: /Agent step Review the diff.*running: Previewing…/,
  })
  expect(within(review).getByText('Previewing…')).toBeTruthy()
  const gate = screen.getByRole('button', { name: /Gate You look at the review.*needs you/ })
  const flag = within(gate).getByText('Needs you')
  expect(flag.getAttribute('data-protected')).toBe('inline')
})

test('a card with problems says how many in its name and carries the flag', () => {
  const issues = indexIssues([
    {
      code: 'incomplete',
      severity: 'error',
      nodeId: 'shots',
      edgeId: null,
      field: null,
      message: 'm',
      help: 'h',
    },
  ])
  mount({ issues })
  const card = screen.getByRole('button', { name: /Screenshots of the change, builder, 1 problem/ })
  expect(card.getAttribute('data-severity')).toBe('error')
})

test('a recipe with no steps says so and offers a first step', () => {
  const { onInsert } = mount({ draft: { ...draft, nodes: [], edges: [] } })
  expect(screen.getByText('This recipe has no steps yet.')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Add a step' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Add an agent step for builder' }))
  expect(onInsert).toHaveBeenCalledWith({ after: '' }, 'agent', 'builder', 'builder')
})

test('the + is a menu: it takes focus, the arrows, Home and End move, and Escape returns to the +', async () => {
  mount()
  const plus = screen.getByRole('button', { name: 'Add a step after the input' })
  plus.focus()
  fireEvent.click(plus)
  const menu = screen.getByRole('menu', { name: 'Add a step after the input' })
  const items = within(menu).getAllByRole('menuitem')
  await waitFor(() => expect(document.activeElement).toBe(items[0]))
  fireEvent.keyDown(menu, { key: 'ArrowDown' })
  expect(document.activeElement).toBe(items[1])
  fireEvent.keyDown(menu, { key: 'End' })
  expect(document.activeElement).toBe(items.at(-1))
  fireEvent.keyDown(menu, { key: 'ArrowDown' })
  expect(document.activeElement).toBe(items[0])
  fireEvent.keyDown(menu, { key: 'ArrowUp' })
  expect(document.activeElement).toBe(items.at(-1))
  fireEvent.keyDown(menu, { key: 'Home' })
  expect(document.activeElement).toBe(items[0])
  fireEvent.keyDown(menu, { key: 'Escape' })
  expect(screen.queryByRole('menu')).toBeNull()
  expect(document.activeElement).toBe(plus)
})

const branchy: Draft = {
  name: 'Triage',
  inputs: [],
  nodes: [
    step('a', 'Look at it', 'builder'),
    {
      id: 'pick',
      kind: 'branch',
      label: 'Pick a path',
      subject: 'a',
      rules: [{ id: 'urgent', when: { kind: 'output_contains', text: 'urgent' } }],
    },
    step('fast', 'Shipped fast', 'builder'),
    step('slow', 'Queued', 'builder'),
    step('loose', 'Loose step', 'reviewer'),
  ],
  edges: [
    { id: 'p1', from: 'a', port: 'ok', to: 'pick' },
    { id: 'p2', from: 'pick', port: 'urgent', to: 'fast' },
    { id: 'p3', from: 'pick', port: 'default', to: 'slow' },
    { id: 'p4', from: 'slow', port: 'ok', to: 'a' },
  ],
}

test('a step with no connection waits under "Not connected", not beside the first step', () => {
  mount({ draft: branchy })
  const group = screen.getByRole('region', { name: 'Not connected' })
  expect(within(group).getByText('Connect it in its settings')).toBeTruthy()
  expect(within(group).getByRole('button', { name: /Loose step/ })).toBeTruthy()
  // The first layer is the input's one step, and its + still works; only the branch's two paths run at the same time.
  expect(screen.getAllByText('at the same time')).toHaveLength(1)
  expect(screen.getByRole('button', { name: 'Add a step after the input' })).toBeTruthy()
})

test('a branch card says which path a run took, and a step reached again by a loop says so', () => {
  const edges = new Map<string, 'taken' | 'skipped'>([
    ['p1', 'taken'],
    ['p2', 'skipped'],
    ['p3', 'taken'],
    ['p4', 'taken'],
  ])
  mount({ draft: branchy, edges, readOnly: true })
  const branch = screen.getByRole('button', { name: /Branch Pick a path/ })
  expect(within(branch).getByText('took: otherwise → Queued')).toBeTruthy()
  const first = screen.getByRole('button', { name: /Agent step Look at it/ })
  expect(within(first).getByText('↩ again')).toBeTruthy()
  expect(
    within(screen.getByRole('button', { name: /Shipped fast/ })).queryByText('↩ again'),
  ).toBeNull()
})

test('nothing is said about a path before a run takes one', () => {
  mount({ draft: branchy, edges: new Map(), readOnly: true })
  expect(screen.queryByText(/took:/)).toBeNull()
  expect(screen.queryByText('↩ again')).toBeNull()
})
