import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { expect, test } from 'vitest'
import {
  approval,
  boldTasksState as state,
  detailOf,
  mount,
  posts,
  task,
} from './BoldTasks-helpers.tsx'

test('below 1280px a picked task opens as a side sheet, and no empty panel sits under the board', async () => {
  state.narrow = true
  state.tasks = [task('t1')]
  state.details.t1 = detailOf(state.tasks[0]!)
  mount()
  await screen.findByRole('button', { name: 'T1 Task t1' })
  expect(screen.queryByRole('complementary', { name: 'Task details' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'T1 Task t1' }))
  const sheet = screen.getByRole('dialog', { name: 'Task details' })
  expect(sheet.className).toContain('bold-tb-sheet--side')
  await within(sheet).findByText('Reproduce it')
})

test('the panel shows the task, its steps and comments, and Comment posts', async () => {
  state.tasks = [task('t1')]
  state.details.t1 = detailOf(state.tasks[0]!)
  mount()
  fireEvent.click(await screen.findByRole('button', { name: 'T1 Task t1' }))
  const panel = screen.getByRole('complementary', { name: 'Task details' })
  await within(panel).findByText('Reproduce it')
  expect(panel.textContent).toContain('Hermes: running')
  expect(within(panel).getByRole('link', { name: 'Feed team' })).toBeTruthy()
  expect(within(panel).getByText('Started on the fix')).toBeTruthy()
  fireEvent.change(within(panel).getByLabelText(/Add a comment for builder/), {
    target: { value: 'Check the edge case' },
  })
  fireEvent.click(within(panel).getByRole('button', { name: 'Comment' }))
  await waitFor(() => expect(posts()).toHaveLength(1))
  expect(posts()[0]!.url).toBe('/api/tasks/t1/actions')
  expect(JSON.parse(String(posts()[0]!.init!.body))).toEqual({
    action: 'comment',
    text: 'Check the edge case',
  })
})

test('a blocked task shows Unblock in a light protected block', async () => {
  state.tasks = [
    task('t4', {
      column: 'needs_you',
      hermesStatus: 'blocked',
      badge: { kind: 'blocked', label: 'Needs a token' },
    }),
  ]
  state.details.t4 = detailOf(state.tasks[0]!)
  mount()
  fireEvent.click(await screen.findByRole('button', { name: 'T4 Task t4' }))
  const block = await screen.findByLabelText('Needs you', { selector: 'div' })
  expect(block.hasAttribute('data-protected')).toBe(true)
  expect(within(block).getByRole('link', { name: 'Open in its room' })).toBeTruthy()
  expect(block.textContent).toContain('Needs a token')
  fireEvent.click(within(block).getByRole('button', { name: 'Unblock' }))
  await waitFor(() => expect(posts()).toHaveLength(1))
  expect(JSON.parse(String(posts()[0]!.init!.body))).toEqual({ action: 'unblock' })
  await within(block).findByText('Sent — waiting for Hermes')
})

test('a pending approval is approved from the panel', async () => {
  state.tasks = [
    task('t6', { column: 'needs_you', badge: { kind: 'needs_you', label: 'Approval' } }),
  ]
  state.details.t6 = detailOf(state.tasks[0]!, { pendingApproval: approval() })
  mount()
  fireEvent.click(await screen.findByRole('button', { name: 'T6 Task t6' }))
  const allow = await screen.findByRole('button', { name: 'Allow' })
  expect(screen.getByText('pnpm migrate')).toBeTruthy()
  fireEvent.click(allow)
  await waitFor(() => expect(posts()).toHaveLength(1))
  expect(posts()[0]!.url).toBe('/api/approvals/ap-1/decision')
  expect(JSON.parse(String(posts()[0]!.init!.body))).toEqual({ choice: 'once' })
})

test('on a phone Needs you comes first with its actions, then the column tabs, and a card opens a sheet', async () => {
  state.phone = true
  state.tasks = [
    task('t1'),
    task('t3', { column: 'planned' }),
    task('t4', {
      column: 'needs_you',
      hermesStatus: 'blocked',
      badge: { kind: 'blocked', label: 'Needs a token' },
    }),
  ]
  state.details.t1 = detailOf(state.tasks[0]!)
  mount()
  const needs = await screen.findByRole('region', { name: 'Needs you' })
  expect(within(needs).getByRole('button', { name: 'Unblock' })).toBeTruthy()
  const tabs = screen.getByRole('tablist', { name: 'Columns' })
  expect(
    within(tabs)
      .getAllByRole('tab')
      .map((tab) => tab.textContent?.split(' ')[0]),
  ).toEqual(['Working', 'Planned', 'In', 'Done'])
  expect(needs.compareDocumentPosition(tabs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  fireEvent.click(within(needs).getByRole('button', { name: 'Unblock' }))
  await waitFor(() => expect(posts()).toHaveLength(1))
  fireEvent.click(screen.getByRole('button', { name: 'T1 Task t1' }))
  const sheet = await screen.findByRole('dialog', { name: 'Task details' })
  await within(sheet).findByText('Reproduce it')
  fireEvent.click(within(sheet).getByRole('button', { name: 'Close task details' }))
  expect(screen.queryByRole('dialog')).toBeNull()
})

// Review (3.16.0): the panel's state belongs to one task, and a phone card only unblocks a blocked task.
test('switching tasks starts a fresh panel: one task’s Unblock or draft never carries to the next', async () => {
  state.tasks = [
    task('t4', {
      column: 'needs_you',
      hermesStatus: 'blocked',
      badge: { kind: 'blocked', label: 'Needs a token' },
    }),
    task('t5', {
      column: 'needs_you',
      hermesStatus: 'blocked',
      badge: { kind: 'blocked', label: 'Needs a key' },
    }),
  ]
  state.details.t4 = detailOf(state.tasks[0]!)
  state.details.t5 = detailOf(state.tasks[1]!)
  mount()
  fireEvent.click(await screen.findByRole('button', { name: 'T4 Task t4' }))
  const first = await screen.findByLabelText('Needs you', { selector: 'div' })
  fireEvent.click(within(first).getByRole('button', { name: 'Unblock' }))
  await within(first).findByText('Sent — waiting for Hermes')
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'half a thought' } })
  fireEvent.click(screen.getByRole('button', { name: 'T5 Task t5' }))
  const second = await screen.findByLabelText('Needs you', { selector: 'div' })
  await within(second).findByText('Needs a key')
  const unblock = within(second).getByRole('button', { name: 'Unblock' }) as HTMLButtonElement
  expect(unblock.disabled).toBe(false)
  expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('')
})

test('on a phone a task waiting on an approval offers Review and decide, never Unblock', async () => {
  state.phone = true
  // As the server sends it: an approval moves the task to Needs you and leaves Hermes' status and badge alone.
  state.tasks = [task('t6', { column: 'needs_you', hermesStatus: 'running', badge: null })]
  state.details.t6 = detailOf(state.tasks[0]!, { pendingApproval: approval() })
  mount()
  const needs = await screen.findByRole('region', { name: 'Needs you' })
  expect(within(needs).queryByRole('button', { name: 'Unblock' })).toBeNull()
  fireEvent.click(within(needs).getByRole('button', { name: 'Review and decide' }))
  const sheet = await screen.findByRole('dialog', { name: 'Task details' })
  expect(await within(sheet).findByRole('button', { name: 'Allow' })).toBeTruthy()
})

test('on a phone a task opens as a bottom sheet with a grip', async () => {
  state.phone = true
  state.tasks = [task('t1')]
  state.details.t1 = detailOf(state.tasks[0]!)
  mount()
  fireEvent.click(await screen.findByRole('button', { name: 'T1 Task t1' }))
  const sheet = await screen.findByRole('dialog', { name: 'Task details' })
  expect(sheet.className).toContain('bold-tb-sheet')
  expect(sheet.className).not.toContain('bold-tb-sheet--side')
  expect(sheet.querySelector('.bold-tb-sheet-grip')?.getAttribute('aria-hidden')).toBe('true')
})
