import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { libraryState, mount } from './BoldLibrary-helpers.tsx'

test('3.22.0: on the phone Knowledge page the Files view is shown full width, with Back to the notes', async () => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('max-width'),
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }))
  mount(null, true)
  fireEvent.click(await screen.findByRole('button', { name: 'Files' }))
  expect(await screen.findByRole('heading', { name: 'Files' })).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: /Back to the notes/ }))
  expect(await screen.findByRole('navigation', { name: 'Library notes' })).toBeDefined()
  expect(screen.queryByRole('heading', { name: 'Files' })).toBeNull()
})

test('folders collapse, empty and nested folders show, and New note starts in the picked folder', async () => {
  libraryState.folders = ['Decisions', 'Decisions/Archive', 'Empty']
  mount()
  const nav = await screen.findByRole('navigation', { name: 'Library notes' })
  expect(await within(nav).findByRole('button', { name: /^Empty/ })).toBeDefined()
  expect(within(nav).getByRole('button', { name: /^Archive/ })).toBeDefined()
  expect(within(nav).getAllByRole('button', { name: /Last edited by/ })).toHaveLength(2)
  // Collapsing hides the folder's notes and its nested folders, and does not pick it.
  fireEvent.click(within(nav).getByRole('button', { name: 'Collapse Decisions' }))
  expect(within(nav).queryAllByRole('button', { name: /Last edited by/ })).toHaveLength(0)
  expect(within(nav).queryByRole('button', { name: /^Archive/ })).toBeNull()
  expect(within(nav).getByRole('button', { name: 'Decisions' }).getAttribute('aria-pressed')).toBe(
    'false',
  )
  fireEvent.click(within(nav).getByRole('button', { name: /^Empty/ }))
  fireEvent.click(within(nav).getByRole('button', { name: /New note/ }))
  expect(((await screen.findByLabelText('Path in Knowledge')) as HTMLInputElement).value).toBe(
    'Empty/',
  )
})

test('the Notes heading goes back to the top level, and a folder that disappears is unpicked', async () => {
  libraryState.folders = ['Decisions', 'Empty']
  mount()
  const nav = await screen.findByRole('navigation', { name: 'Library notes' })
  fireEvent.click(await within(nav).findByRole('button', { name: /^Empty/ }))
  fireEvent.click(within(nav).getByRole('button', { name: 'Notes' }))
  fireEvent.click(within(nav).getByRole('button', { name: /New note/ }))
  expect(((await screen.findByLabelText('Path in Knowledge')) as HTMLInputElement).value).toBe('')
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  fireEvent.click(within(nav).getByRole('button', { name: /^Empty/ }))
  libraryState.folders = ['Decisions']
  await act(async () => {
    await libraryState.client!.invalidateQueries()
  })
  await waitFor(() => expect(within(nav).queryByRole('button', { name: /^Empty/ })).toBeNull())
  fireEvent.click(within(nav).getByRole('button', { name: /New note/ }))
  expect(((await screen.findByLabelText('Path in Knowledge')) as HTMLInputElement).value).toBe('')
})

test('a note opened from Search expands its folded folder chain', async () => {
  libraryState.folders = ['Decisions']
  sessionStorage.setItem('score.library.collapsed', JSON.stringify(['Decisions']))
  mount('Decisions/Source.md')
  const nav = await screen.findByRole('navigation', { name: 'Library notes' })
  await waitFor(() =>
    expect(within(nav).getAllByRole('button', { name: /Last edited by/ })).toHaveLength(2),
  )
  expect(
    within(nav).getByRole('button', { name: 'Collapse Decisions' }).getAttribute('aria-expanded'),
  ).toBe('true')
})

test('New folder in the notes list creates the folder and stays on the notes', async () => {
  mount()
  const nav = await screen.findByRole('navigation', { name: 'Library notes' })
  fireEvent.click(await within(nav).findByRole('button', { name: /New folder/ }))
  const input = (await screen.findByLabelText('Folder path')) as HTMLInputElement
  fireEvent.change(input, { target: { value: 'Plans' } })
  fireEvent.submit(input.closest('form')!)
  await waitFor(() =>
    expect(
      vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('/api/knowledge/folders')),
    ).toBe(true),
  )
  expect(screen.queryByRole('button', { name: 'Files', pressed: true })).toBeNull()
})

test('3.14.5: a folder with notes in it can be renamed and deleted from Files', async () => {
  mount()
  fireEvent.click(await screen.findByRole('button', { name: 'Files' }))
  const files = await screen.findByRole('region', { name: 'Files in this folder' })
  // Rename: the whole folder moves, with links updated.
  fireEvent.click(within(files).getByRole('button', { name: 'Rename Decisions' }))
  const moveDialog = await screen.findByRole('dialog', {
    name: /Rename or move the folder Decisions/,
  })
  fireEvent.change(within(moveDialog).getByLabelText('New folder path'), {
    target: { value: 'Archive/Decisions' },
  })
  fireEvent.click(within(moveDialog).getByRole('button', { name: 'Move folder' }))
  await screen.findByText(/Moved the folder to Archive\/Decisions; links updated in 1 notes/)
  const moved = vi
    .mocked(fetch)
    .mock.calls.find(([url]) => String(url).includes('/api/knowledge/folders/move'))!
  expect(JSON.parse(String(moved[1]!.body))).toEqual({
    from: 'Decisions',
    to: 'Archive/Decisions',
    updateLinks: true,
  })
  // Delete: the folder has notes in it, so it asks first and says what goes with it.
  fireEvent.click(within(files).getByRole('button', { name: 'Delete Decisions' }))
  const deleteDialog = await screen.findByRole('dialog', { name: 'Delete the folder Decisions?' })
  expect(deleteDialog.textContent).toMatch(/Everything in it goes too: \d+ notes?/)
  fireEvent.click(within(deleteDialog).getByRole('button', { name: 'Delete folder and contents' }))
  await screen.findByText('Deleted the folder Decisions.')
  expect(
    vi
      .mocked(fetch)
      .mock.calls.some(
        ([url, init]) =>
          String(url).includes('/api/knowledge/folders/Decisions?contents=1') &&
          init?.method === 'DELETE',
      ),
  ).toBe(true)
})

test('3.27.1: the Knowledge page no longer lists who can read it', async () => {
  mount(null, true)
  await screen.findByRole('complementary', { name: 'Folders' })
  expect(screen.queryByText('Who can read it')).toBeNull()
  expect(screen.queryByRole('region', { name: 'Who can read it' })).toBeNull()
})

test('3.27.1: the rail’s New folder creates inside the selected folder; the list no longer has the folder buttons', async () => {
  mount(null, true)
  const rail = await screen.findByRole('complementary', { name: 'Folders' })
  const nav = screen.getByRole('navigation', { name: 'Library notes' })
  expect(within(nav).queryByRole('button', { name: /New folder/ })).toBeNull()
  expect(within(nav).queryByRole('button', { name: /Rename folder/ })).toBeNull()
  expect(within(nav).queryByRole('button', { name: /Delete folder/ })).toBeNull()
  fireEvent.click(await within(rail).findByRole('button', { name: /^Decisions/ }))
  fireEvent.click(within(rail).getByRole('button', { name: /New folder/ }))
  const input = (await screen.findByLabelText('Folder path')) as HTMLInputElement
  expect(input.value).toBe('Decisions/')
  fireEvent.change(input, { target: { value: 'Decisions/Plans' } })
  fireEvent.submit(input.closest('form')!)
  await waitFor(() =>
    expect(
      vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('/api/knowledge/folders')),
    ).toBe(true),
  )
})

test('3.27.1: a folder’s ⋯ menu reaches Rename, Move and Delete, and is a real menu', async () => {
  mount(null, true)
  const rail = await screen.findByRole('complementary', { name: 'Folders' })
  // Only real folders have one.
  expect(await within(rail).findAllByRole('button', { name: /^Folder actions for/ })).toHaveLength(
    1,
  )
  const trigger = within(rail).getByRole('button', { name: 'Folder actions for Decisions' })
  fireEvent.click(trigger)
  const menu = await screen.findByRole('menu', { name: 'Decisions actions' })
  const items = within(menu).getAllByRole('menuitem')
  expect(items.map((item) => item.textContent)).toEqual(['Rename…', 'Move to…', 'Delete…'])
  await waitFor(() => expect(document.activeElement).toBe(items[0]))
  // Arrows move, wrapping; Escape closes and returns focus to the ⋯.
  fireEvent.keyDown(menu, { key: 'ArrowDown' })
  expect(document.activeElement).toBe(items[1])
  fireEvent.keyDown(menu, { key: 'ArrowUp' })
  fireEvent.keyDown(menu, { key: 'ArrowUp' })
  expect(document.activeElement).toBe(items[2])
  fireEvent.keyDown(menu, { key: 'Home' })
  expect(document.activeElement).toBe(items[0])
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(screen.queryByRole('menu')).toBeNull()
  expect(document.activeElement).toBe(trigger)
  // Rename and Move open the folder-move flow, Delete the confirm.
  for (const label of ['Rename…', 'Move to…']) {
    fireEvent.click(trigger)
    fireEvent.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: label }))
    const dialog = await screen.findByRole('dialog', {
      name: /Rename or move the folder Decisions/,
    })
    fireEvent.click(within(dialog).getByRole('button', { name: /Cancel/ }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  }
  fireEvent.click(trigger)
  fireEvent.click(
    within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Delete…' }),
  )
  expect(await screen.findByRole('dialog', { name: 'Delete the folder Decisions?' })).toBeDefined()
})

test('3.27.1 review: a tap on the menu’s scrim closes it without reaching what lies beneath', async () => {
  mount(null, true)
  const rail = await screen.findByRole('complementary', { name: 'Folders' })
  const trigger = await within(rail).findByRole('button', { name: 'Folder actions for Decisions' })
  fireEvent.click(trigger)
  const menu = await screen.findByRole('menu', { name: 'Decisions actions' })
  const scrim = document.querySelector('.bold-knowledge-scrim')!
  // The scrim is part of the menu's own root, so its pointerdown is not an outside tap that would let the click through.
  fireEvent.pointerDown(scrim)
  expect(screen.getByRole('menu')).toBe(menu)
  fireEvent.click(scrim)
  expect(screen.queryByRole('menu')).toBeNull()
  expect(document.activeElement).toBe(trigger)
  expect(screen.queryByRole('dialog')).toBeNull()
})
