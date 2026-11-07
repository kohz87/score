import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { boldTasksState as state, detailOf, mount, posts, task } from './BoldTasks-helpers.tsx'

test('+ New task opens the dialog; Create task posts once with an Idempotency-Key, and the task opens selected', async () => {
  state.tasks = [task('t-new', { title: 'Brand new' })]
  state.details['t-new'] = detailOf(state.tasks[0]!)
  mount()
  fireEvent.click(await screen.findByRole('button', { name: 'New task' }))
  const dialog = screen.getByRole('dialog', { name: 'New task' })
  expect(within(dialog).getByText(/\/assign @builder/)).toBeTruthy()
  fireEvent.change(within(dialog).getByLabelText('What needs doing'), {
    target: { value: '  Brand new  ' },
  })
  fireEvent.change(within(dialog).getByLabelText('Details (optional)'), {
    target: { value: 'With details' },
  })
  fireEvent.change(within(dialog).getByLabelText('In which chat'), { target: { value: 'room-a' } })
  fireEvent.click(within(dialog).getByRole('radio', { name: 'Plan it for later' }))
  const create = within(dialog).getByRole('button', { name: 'Create task' })
  fireEvent.click(create)
  fireEvent.click(create)
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New task' })).toBeNull())
  const sent = posts().filter((item) => item.url === '/api/tasks')
  expect(sent).toHaveLength(1)
  expect(JSON.parse(String(sent[0]!.init!.body))).toEqual({
    title: 'Brand new',
    body: 'With details',
    assignee: 'builder',
    roomId: 'room-a',
    start: 'later',
  })
  expect(new Headers(sent[0]!.init!.headers).get('Idempotency-Key')).toBeTruthy()
  const panel = screen.getByRole('complementary', { name: 'Task details' })
  expect(await within(panel).findByRole('heading', { name: 'Brand new' })).toBeTruthy()
})

test('New task needs a title, shows a refused create in plain words, and renews its key after a 4xx', async () => {
  state.tasks = [task('t1')]
  mount()
  fireEvent.click(await screen.findByRole('button', { name: 'New task' }))
  const dialog = screen.getByRole('dialog', { name: 'New task' })
  const submit = () => fireEvent.submit(dialog.querySelector('form')!)
  submit()
  expect((await within(dialog).findByRole('alert')).textContent).toBe('Say what needs doing first.')
  expect(posts()).toHaveLength(0)
  fireEvent.change(within(dialog).getByLabelText('What needs doing'), { target: { value: 'X' } })
  state.createFails = 1
  submit()
  await waitFor(() => expect(within(dialog).getByRole('alert').textContent).toBe('No such chat.'))
  submit()
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New task' })).toBeNull())
  const keys = posts().map((item) => new Headers(item.init!.headers).get('Idempotency-Key'))
  expect(keys).toHaveLength(2)
  expect(keys[0]).not.toBe(keys[1])
})

test('New task closes with Escape and Cancel without posting', async () => {
  state.tasks = [task('t1')]
  mount()
  const opener = await screen.findByRole('button', { name: 'New task' })
  fireEvent.click(opener)
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(screen.queryByRole('dialog', { name: 'New task' })).toBeNull()
  fireEvent.click(opener)
  fireEvent.click(
    within(screen.getByRole('dialog', { name: 'New task' })).getByRole('button', {
      name: 'Cancel',
    }),
  )
  expect(screen.queryByRole('dialog', { name: 'New task' })).toBeNull()
  expect(posts()).toHaveLength(0)
})

test('New task is a native modal dialog: showModal on open, Escape (cancel) closes it, focus returns to + New task', async () => {
  const proto = HTMLDialogElement.prototype as { showModal?: () => void }
  const original = proto.showModal
  const shown = vi.fn(function (this: HTMLDialogElement) {
    this.setAttribute('open', '')
  })
  proto.showModal = shown
  try {
    state.tasks = [task('t1')]
    mount()
    const opener = await screen.findByRole('button', { name: 'New task' })
    opener.focus()
    fireEvent.click(opener)
    const dialog = screen.getByRole('dialog', { name: 'New task' })
    expect(dialog.tagName).toBe('DIALOG')
    expect(shown).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(within(dialog).getByLabelText('What needs doing'))
    fireEvent(dialog, new Event('cancel', { cancelable: true }))
    expect(screen.queryByRole('dialog', { name: 'New task' })).toBeNull()
    expect(document.activeElement).toBe(opener)
  } finally {
    proto.showModal = original
  }
})
