import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { expect, test } from 'vitest'
import { job, mount, repeating as state, sent } from './repeating-helpers.tsx'

function seed() {
  state.jobs = [
    job('b1', 'builder', {
      title: 'Morning summary',
      description: 'Summarise yesterday',
      deliverTo: { roomId: 'room-a', roomName: 'Team room' },
    }),
    job('l1', 'lead', { title: 'Weekly report', model: 'deep', enabled: false }),
  ]
}

async function openEdit(title: string) {
  fireEvent.click(await screen.findByRole('button', { name: `Edit ${title}` }))
  return screen.findByRole('complementary', { name: `Edit ${title}` })
}
const writes = () => state.requests.filter((item) => item.method !== 'GET')

test('a new job: agent chips (Hermes agents only), fields, and one create with a key and the browser zone', async () => {
  seed()
  mount()
  fireEvent.click(await screen.findByRole('button', { name: 'New repeating job' }))
  const panel = await screen.findByRole('complementary', { name: 'New repeating job' })
  const who = within(panel).getByRole('radiogroup', { name: 'Assigned to' })
  expect(within(who).queryByRole('radio', { name: 'coder' })).toBeNull()
  expect(within(who).getByRole('radio', { name: 'builder' }).getAttribute('aria-checked')).toBe(
    'true',
  )
  fireEvent.click(within(panel).getByRole('button', { name: 'Save' }))
  expect((await within(panel).findByRole('alert')).textContent).toBe('Give it a title first.')
  expect(writes()).toHaveLength(0)
  fireEvent.change(within(panel).getByLabelText('Title'), { target: { value: ' Check deps ' } })
  fireEvent.change(within(panel).getByLabelText('What it does'), {
    target: { value: 'Look for old packages' },
  })
  fireEvent.click(within(panel).getByRole('radio', { name: 'Weekdays' }))
  fireEvent.change(within(panel).getByLabelText('Time'), { target: { value: '09:30' } })
  expect(within(panel).getByText(/your time \(.*\) · next: /)).toBeTruthy()
  fireEvent.click(within(who).getByRole('radio', { name: 'lead' }))
  fireEvent.click(within(panel).getByRole('radio', { name: 'Nowhere, just the run' }))
  fireEvent.click(within(panel).getByRole('button', { name: 'Save' }))
  await waitFor(() =>
    expect(screen.queryByRole('complementary', { name: 'New repeating job' })).toBeNull(),
  )
  const made = sent('POST', '/api/agents/')
  expect(made).toHaveLength(1)
  expect(made[0]!.path).toBe('/api/agents/lead/routines')
  expect(made[0]!.key).toBeTruthy()
  expect(made[0]!.body).toEqual({
    title: 'Check deps',
    prompt: 'Look for old packages',
    schedule: '30 9 * * 1-5',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  })
})

test('Custom takes cron or every 2h as typed and refuses what Hermes would not', async () => {
  seed()
  mount()
  const panel = await openEdit('Morning summary')
  fireEvent.click(within(panel).getByRole('radio', { name: 'Custom' }))
  fireEvent.change(within(panel).getByLabelText('Schedule'), { target: { value: 'whenever' } })
  fireEvent.click(within(panel).getByRole('button', { name: 'Save' }))
  expect((await within(panel).findByRole('alert')).textContent).toMatch(/isn’t a schedule/)
  fireEvent.change(within(panel).getByLabelText('Schedule'), { target: { value: 'every 2h' } })
  fireEvent.click(within(panel).getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(sent('PATCH')).toHaveLength(1))
  expect(sent('PATCH')[0]!.body).toMatchObject({ schedule: 'every 2h' })
})

test('Edit sends only what changed, and nothing when nothing did', async () => {
  seed()
  mount()
  let panel = await openEdit('Morning summary')
  expect((within(panel).getByLabelText('What it does') as HTMLTextAreaElement).value).toBe(
    'Summarise yesterday',
  )
  fireEvent.click(within(panel).getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(screen.queryByRole('complementary')).toBeNull())
  expect(writes()).toHaveLength(0)
  panel = await openEdit('Morning summary')
  fireEvent.change(within(panel).getByLabelText('Title'), { target: { value: 'Morning digest' } })
  fireEvent.click(within(panel).getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(sent('PATCH')).toHaveLength(1))
  expect(sent('PATCH')[0]).toMatchObject({
    path: '/api/routines/b1',
    body: { title: 'Morning digest' },
  })
})

test('the model: pin from the list, and unpin back to its own', async () => {
  seed()
  mount()
  let panel = await openEdit('Morning summary')
  fireEvent.click(within(panel).getByRole('radio', { name: 'Pinned' }))
  const list = await within(panel).findByRole('radiogroup', { name: 'Pinned model' })
  expect(await within(list).findByText('acme-fast')).toBeTruthy()
  fireEvent.click(within(list).getByRole('radio', { name: /acme-fast/ }))
  fireEvent.click(within(panel).getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(sent('PATCH')).toHaveLength(1))
  expect(sent('PATCH')[0]!.body).toEqual({ model: { model: 'acme-fast', provider: 'acme' } })
  fireEvent.click(await screen.findByRole('button', { name: 'Edit Weekly report' }))
  panel = await screen.findByRole('complementary', { name: 'Edit Weekly report' })
  expect(within(panel).getByRole('radio', { name: 'Pinned' }).getAttribute('aria-checked')).toBe(
    'true',
  )
  fireEvent.click(within(panel).getByRole('radio', { name: 'Its own (demo-model)' }))
  fireEvent.click(within(panel).getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(sent('PATCH')).toHaveLength(2))
  expect(sent('PATCH')[1]).toMatchObject({ path: '/api/routines/l1', body: { model: null } })
})

test('an alias pins without a provider', async () => {
  seed()
  mount()
  const panel = await openEdit('Morning summary')
  fireEvent.click(within(panel).getByRole('radio', { name: 'Pinned' }))
  fireEvent.click(await within(panel).findByRole('radio', { name: /deep/ }))
  fireEvent.click(within(panel).getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(sent('PATCH')).toHaveLength(1))
  expect(sent('PATCH')[0]!.body).toEqual({ model: { model: 'deep', provider: null } })
})

test('results: a picked chat, then nowhere', async () => {
  state.jobs = [job('b2', 'builder', { title: 'Plain' })]
  mount()
  const panel = await openEdit('Plain')
  fireEvent.click(within(panel).getByRole('radio', { name: 'A chat…' }))
  fireEvent.click(within(panel).getByRole('button', { name: 'Save' }))
  expect((await within(panel).findByRole('alert')).textContent).toBe(
    'Pick the chat the results go to.',
  )
  fireEvent.change(within(panel).getByLabelText('Chat for the results'), {
    target: { value: 'room-a' },
  })
  fireEvent.click(within(panel).getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(sent('PATCH')).toHaveLength(1))
  expect(sent('PATCH')[0]!.body).toEqual({ deliverTo: 'room-a' })
})

test('changing the agent shows the protected note and moves first, then patches the new id', async () => {
  seed()
  mount()
  const panel = await openEdit('Morning summary')
  fireEvent.click(within(panel).getByRole('radio', { name: 'reviewer' }))
  const note = within(panel).getByText('Moving it to reviewer?').parentElement!
  expect(note.getAttribute('data-protected')).toBe('block')
  fireEvent.change(within(panel).getByLabelText('Title'), { target: { value: 'Digest' } })
  fireEvent.click(within(panel).getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(sent('PATCH')).toHaveLength(1))
  const order = writes().map((item) => `${item.method} ${item.path}`)
  expect(order).toEqual(['POST /api/routines/b1/move', 'PATCH /api/routines/reviewer:moved'])
  expect(writes()[0]).toMatchObject({ body: { agentId: 'reviewer' } })
  expect(writes()[0]!.key).toBeTruthy()
  expect(writes()[1]!.body).toEqual({ title: 'Digest' })
  await waitFor(() => expect(screen.queryByRole('complementary')).toBeNull())
})

test('a move that could not remove the old job says who still has it, with Remove', async () => {
  seed()
  state.moveLeftBehind = 'builder:b1'
  mount()
  const panel = await openEdit('Morning summary')
  fireEvent.click(within(panel).getByRole('radio', { name: 'reviewer' }))
  fireEvent.click(within(panel).getByRole('button', { name: 'Save' }))
  const text = await within(panel).findByText(
    'builder still has it: Hermes didn’t remove it. Remove it there or try again.',
  )
  expect(text.parentElement!.getAttribute('data-protected')).toBe('block')
  // No other change: nothing to patch, and the panel stays open for the note.
  expect(sent('PATCH')).toHaveLength(0)
  fireEvent.click(within(panel).getByRole('button', { name: 'Remove' }))
  await waitFor(() => expect(sent('DELETE')).toHaveLength(1))
  expect(sent('DELETE')[0]!.path).toBe('/api/routines/builder:b1')
  await waitFor(() => expect(screen.queryByRole('complementary')).toBeNull())
})

test('a refused move stops there and says so', async () => {
  seed()
  state.fail.add('POST /api/routines/b1/move')
  mount()
  const panel = await openEdit('Morning summary')
  fireEvent.click(within(panel).getByRole('radio', { name: 'reviewer' }))
  fireEvent.change(within(panel).getByLabelText('Title'), { target: { value: 'Digest' } })
  fireEvent.click(within(panel).getByRole('button', { name: 'Save' }))
  expect((await within(panel).findAllByText('Hermes said no.')).length).toBeGreaterThan(0)
  expect(sent('PATCH')).toHaveLength(0)
})

test('Delete… asks first; Keep it changes nothing, Delete it removes the job', async () => {
  seed()
  mount()
  const panel = await openEdit('Morning summary')
  fireEvent.click(within(panel).getByRole('button', { name: 'Delete…' }))
  const ask = within(panel).getByText('Delete “Morning summary”?').parentElement!
  expect(ask.getAttribute('data-protected')).toBe('block')
  expect(sent('DELETE')).toHaveLength(0)
  fireEvent.click(within(panel).getByRole('button', { name: 'Keep it' }))
  expect(within(panel).queryByText('Delete “Morning summary”?')).toBeNull()
  fireEvent.click(within(panel).getByRole('button', { name: 'Delete…' }))
  fireEvent.click(within(panel).getByRole('button', { name: 'Delete it' }))
  await waitFor(() => expect(sent('DELETE')).toHaveLength(1))
  expect(sent('DELETE')[0]!.path).toBe('/api/routines/b1')
})

test('Pause and Resume send only enabled', async () => {
  seed()
  mount()
  let panel = await openEdit('Morning summary')
  fireEvent.click(within(panel).getByRole('button', { name: 'Pause' }))
  await waitFor(() => expect(sent('PATCH')).toHaveLength(1))
  expect(sent('PATCH')[0]!.body).toEqual({ enabled: false })
  fireEvent.click(await screen.findByRole('button', { name: 'Edit Weekly report' }))
  panel = await screen.findByRole('complementary', { name: 'Edit Weekly report' })
  fireEvent.click(within(panel).getByRole('button', { name: 'Resume' }))
  await waitFor(() => expect(sent('PATCH')).toHaveLength(2))
  expect(sent('PATCH')[1]!.body).toEqual({ enabled: true })
})

test('A recipe… swaps the agents for the recipes, and back', async () => {
  seed()
  mount()
  const panel = await openEdit('Morning summary')
  fireEvent.click(within(panel).getByRole('button', { name: 'A recipe…' }))
  expect(
    (await within(panel).findByRole('link', { name: 'Release notes' })).getAttribute('href'),
  ).toBe('/b/tasks/recipes/wf1')
  expect(within(panel).queryByRole('radio', { name: 'builder' })).toBeNull()
  fireEvent.click(within(panel).getByRole('button', { name: 'Back to agents' }))
  expect(within(panel).getByRole('radio', { name: 'builder' })).toBeTruthy()
})

test('under 1280px the panel is a sheet; on a phone, a full-height one', async () => {
  seed()
  state.wide = false
  state.phone = true
  mount()
  fireEvent.click(await screen.findByRole('button', { name: 'Edit Morning summary' }))
  const sheet = await screen.findByRole('dialog', { name: 'Edit Morning summary' })
  expect(sheet.className).toContain('bold-rj-sheet')
  expect(sheet.className).not.toContain('bold-tb-sheet--side')
  expect(within(sheet).getByRole('button', { name: 'Save' })).toBeTruthy()
  fireEvent.click(within(sheet).getByRole('button', { name: 'Close' }))
  expect(screen.queryByRole('dialog')).toBeNull()
})
