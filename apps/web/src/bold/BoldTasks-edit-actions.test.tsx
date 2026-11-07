import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { expect, test } from 'vitest'
import { boldTasksState as state, detailOf, mount, posts, task } from './BoldTasks-helpers.tsx'

const openTask = async (id = 't1', patch: Record<string, unknown> = {}, detail = {}) => {
  state.tasks = [task(id, patch)]
  state.details[id] = detailOf(state.tasks[0]!, { body: 'Page the feed.', ...detail })
  mount()
  fireEvent.click(await screen.findByRole('button', { name: `${id.toUpperCase()} Task ${id}` }))
  const panel = screen.getByRole('complementary', { name: 'Task details' })
  await within(panel).findByText('Reproduce it')
  return panel
}

test('Edit sends only what changed, and Cancel leaves the task alone', async () => {
  const panel = await openTask()
  fireEvent.click(within(panel).getByRole('button', { name: 'Edit' }))
  fireEvent.change(within(panel).getByLabelText('Title'), { target: { value: 'A better title' } })
  fireEvent.change(within(panel).getByLabelText('Doing it'), { target: { value: 'lead' } })
  fireEvent.click(within(panel).getByRole('button', { name: 'Save changes' }))
  await waitFor(() =>
    expect(state.requests.filter((item) => item.init?.method === 'PATCH')).toHaveLength(1),
  )
  const patch = state.requests.find((item) => item.init?.method === 'PATCH')!
  expect(patch.url).toBe('/api/tasks/t1')
  expect(JSON.parse(String(patch.init!.body))).toEqual({
    title: 'A better title',
    assignee: 'lead',
  })
  await waitFor(() =>
    expect(within(panel).queryByRole('button', { name: 'Save changes' })).toBeNull(),
  )
  fireEvent.click(within(panel).getByRole('button', { name: 'Edit' }))
  fireEvent.change(within(panel).getByLabelText('Description'), { target: { value: 'changed' } })
  fireEvent.click(within(panel).getByRole('button', { name: 'Cancel' }))
  expect(within(panel).queryByLabelText('Description')).toBeNull()
  expect(state.requests.filter((item) => item.init?.method === 'PATCH')).toHaveLength(1)
})

test('Save changes without a change sends nothing; an empty title is refused', async () => {
  const panel = await openTask()
  fireEvent.click(within(panel).getByRole('button', { name: 'Edit' }))
  fireEvent.change(within(panel).getByLabelText('Title'), { target: { value: '  ' } })
  fireEvent.click(within(panel).getByRole('button', { name: 'Save changes' }))
  expect((await within(panel).findByRole('alert')).textContent).toBe('A task needs a title.')
  fireEvent.change(within(panel).getByLabelText('Title'), { target: { value: 'Task t1' } })
  fireEvent.click(within(panel).getByRole('button', { name: 'Save changes' }))
  await waitFor(() => expect(within(panel).queryByLabelText('Title')).toBeNull())
  expect(state.requests.filter((item) => item.init?.method === 'PATCH')).toHaveLength(0)
})

test('only the moves that fit the column are offered, and each posts its action', async () => {
  const panel = await openTask()
  const moves = within(panel).getByRole('region', { name: 'Move it' })
  expect(
    within(moves)
      .getAllByRole('button')
      .map((b) => b.textContent),
  ).toEqual(['Ask for review', 'Block', 'Mark done'])
  fireEvent.click(within(moves).getByRole('button', { name: 'Ask for review' }))
  await waitFor(() => expect(posts()).toHaveLength(1))
  expect(posts()[0]!.url).toBe('/api/tasks/t1/actions')
  expect(JSON.parse(String(posts()[0]!.init!.body))).toEqual({ action: 'request_review' })
  fireEvent.click(within(moves).getByRole('button', { name: 'Mark done' }))
  await waitFor(() => expect(posts()).toHaveLength(2))
  expect(JSON.parse(String(posts()[1]!.init!.body))).toEqual({ action: 'complete' })
})

test('a planned task offers Start, a done one offers no moves', async () => {
  const panel = await openTask('t1', { column: 'planned', hermesStatus: 'todo' })
  const moves = within(panel).getByRole('region', { name: 'Move it' })
  fireEvent.click(within(moves).getByRole('button', { name: 'Start' }))
  await waitFor(() => expect(posts()).toHaveLength(1))
  expect(JSON.parse(String(posts()[0]!.init!.body))).toEqual({ action: 'start' })
  cleanup()
  const done = await openTask('t2', { column: 'done', hermesStatus: 'done' })
  expect(within(done).queryByRole('region', { name: 'Move it' })).toBeNull()
})

test('Archive asks first, in a protected confirm, then archives and the task leaves the board', async () => {
  const panel = await openTask()
  fireEvent.click(within(panel).getByRole('button', { name: 'Archive…' }))
  const confirm = within(panel).getByRole('alertdialog', { name: 'Archive this task?' })
  expect(confirm.getAttribute('data-protected')).toBe('flex')
  expect(posts()).toHaveLength(0)
  fireEvent.click(within(confirm).getByRole('button', { name: 'Keep it' }))
  expect(within(panel).queryByRole('alertdialog')).toBeNull()
  expect(posts()).toHaveLength(0)
  fireEvent.click(within(panel).getByRole('button', { name: 'Archive…' }))
  fireEvent.click(within(panel).getByRole('button', { name: 'Archive task' }))
  await waitFor(() => expect(posts()).toHaveLength(1))
  expect(JSON.parse(String(posts()[0]!.init!.body))).toEqual({ action: 'archive' })
  await waitFor(() => expect(screen.queryByRole('button', { name: 'T1 Task t1' })).toBeNull())
})

test('the Archive confirm takes focus, Escape keeps the task, and focus returns to Archive…', async () => {
  const panel = await openTask()
  fireEvent.click(within(panel).getByRole('button', { name: 'Archive…' }))
  const confirm = within(panel).getByRole('alertdialog', { name: 'Archive this task?' })
  expect(document.activeElement).toBe(confirm)
  fireEvent.keyDown(confirm, { key: 'Escape' })
  expect(within(panel).queryByRole('alertdialog')).toBeNull()
  expect(document.activeElement).toBe(within(panel).getByRole('button', { name: 'Archive…' }))
  expect(posts()).toHaveLength(0)
})
