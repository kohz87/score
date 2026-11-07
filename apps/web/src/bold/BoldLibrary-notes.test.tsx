import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { expect, onTestFinished, test, vi } from 'vitest'
import { HeldUpload, libraryState, mount, notes } from './BoldLibrary-helpers.tsx'

test('lists folders, titles and who last edited each note, and opens the first note', async () => {
  mount()
  expect(await screen.findByText('Decisions')).toBeDefined()
  expect(screen.getAllByText('Event cursors').length).toBeGreaterThan(0)
  const nav = screen.getByRole('navigation', { name: 'Library notes' })
  expect(within(nav).getAllByRole('button', { name: /Last edited by/ })).toHaveLength(2)
  expect(screen.getByText('reviewer')).toBeDefined()
  expect(await screen.findByLabelText('Contents of Decisions/Event cursors.md')).toBeDefined()
  expect(screen.queryByText(/Activity feed job/)).toBeNull()
})

test('on a phone the list folds once a note is chosen, unfolds on a tap and folds again on the next pick (3.8.1)', async () => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('max-width'),
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }))
  // A phone pick scrolls the note into view in a later frame; jsdom has no scrollIntoView.
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    value: () => undefined,
    configurable: true,
    writable: true,
  })
  onTestFinished(() => {
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
  })
  mount()
  const nav = await screen.findByRole('navigation', { name: 'Library notes' })
  // Nothing chosen yet: the list is open, as before.
  const notes = await within(nav).findAllByRole('button', { name: /Last edited by/ })
  expect(within(nav).queryByRole('button', { name: /Notes and files/ })).toBeNull()
  fireEvent.click(notes[0]!)
  const fold = await within(nav).findByRole('button', { name: /Notes and files/ })
  expect(fold.getAttribute('aria-expanded')).toBe('false')
  expect(within(nav).queryAllByRole('button', { name: /Last edited by/ })).toHaveLength(0)
  fireEvent.click(fold)
  expect(
    within(nav)
      .getByRole('button', { name: /Hide the list/ })
      .getAttribute('aria-expanded'),
  ).toBe('true')
  fireEvent.click(within(nav).getAllByRole('button', { name: /Last edited by/ })[1]!)
  expect(await within(nav).findByRole('button', { name: /Notes and files/ })).toBeDefined()
})

test('an outside edit gets its own wording in the byline', async () => {
  libraryState.entries = [{ ...notes[0]!, lastAuthor: 'outside' }]
  mount()
  const nav = await screen.findByRole('navigation', { name: 'Library notes' })
  expect(await within(nav).findByText('Last edited outside Score')).toBeDefined()
})

test('a note shows links, backlinks, properties and history; a backlink opens in the panel', async () => {
  mount()
  const details = await screen.findByRole('complementary', { name: 'Note details' })
  expect(within(details).getByRole('heading', { name: 'Backlinks' })).toBeDefined()
  expect(within(details).getByRole('heading', { name: 'Properties' })).toBeDefined()
  expect(within(details).getByRole('heading', { name: 'History' })).toBeDefined()
  expect(within(details).getByText('draft')).toBeDefined()
  fireEvent.click(within(details).getByRole('button', { name: 'Source' }))
  expect(await screen.findByLabelText('Contents of Decisions/Source.md')).toBeDefined()
})

test('search opens a hit without leaving the panel', async () => {
  libraryState.searchItems = [
    {
      path: 'Decisions/Source.md',
      title: 'Source',
      snippet: 'the [[budget]] line',
      kind: 'note',
      type: null,
    },
  ]
  mount()
  fireEvent.change(screen.getByPlaceholderText('Search'), { target: { value: 'budget' } })
  const results = await screen.findByRole('region', { name: 'Search results' })
  const hit = await within(results).findByRole('button', { name: /Source/ })
  fireEvent.click(hit)
  expect(await screen.findByLabelText('Contents of Decisions/Source.md')).toBeDefined()
  expect(screen.getByPlaceholderText('Search')).toHaveProperty('value', '')
})

test('a note named by Search opens instead of the first note', async () => {
  mount('Decisions/Source.md')
  expect(await screen.findByLabelText('Contents of Decisions/Source.md')).toBeDefined()
  expect(screen.queryByLabelText('Contents of Decisions/Event cursors.md')).toBeNull()
})

test('an empty Library says so instead of inventing a note', async () => {
  libraryState.entries = []
  mount()
  expect(await screen.findByText('The Library is empty')).toBeDefined()
  expect(screen.getByText('No notes yet. Start one below or upload a file.')).toBeDefined()
  expect(screen.queryByRole('textbox', { name: /Contents of/ })).toBeNull()
})

test('a tree error is shown in words', async () => {
  libraryState.treeError = true
  mount()
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Couldn’t load the notes.')
})

test('deleting the open note keeps the blank state instead of opening another', async () => {
  mount()
  const editor = await screen.findByLabelText('Contents of Decisions/Event cursors.md')
  fireEvent.click(
    within(editor.closest('.kn-note') as HTMLElement).getByRole('button', { name: 'Delete' }),
  )
  const dialog = await screen.findByRole('dialog', { name: 'Delete Event cursors?' })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete note' }))
  expect(await screen.findByText('Pick a note')).toBeDefined()
  expect(screen.queryByLabelText('Contents of Decisions/Source.md')).toBeNull()
})

test('upload uses the open note folder, and a folder accepts dropped files with the classic hint', async () => {
  vi.stubGlobal('XMLHttpRequest', HeldUpload)
  mount()
  await screen.findByLabelText('Contents of Decisions/Event cursors.md')
  fireEvent.change(screen.getByLabelText('Choose files to upload to the Library'), {
    target: { files: [new File(['one'], 'notes.pdf', { type: 'application/pdf' })] },
  })
  await waitFor(() =>
    expect(HeldUpload.last.url).toBe('/api/knowledge/files/Decisions/notes.pdf?onConflict=ask'),
  )
  act(() => {
    HeldUpload.last.responseText = JSON.stringify({
      path: 'Decisions/notes.pdf',
      kind: 'document',
      replaced: false,
    })
    HeldUpload.last.onload?.()
  })
  await waitFor(() => expect(screen.queryByRole('button', { name: /Uploading…/ })).toBeNull())

  const group = screen.getByRole('region', { name: 'Decisions' })
  const dataTransfer = {
    types: ['Files'],
    files: [new File(['two'], 'dropped.pdf', { type: 'application/pdf' })],
  }
  fireEvent.dragOver(group, { dataTransfer })
  expect(screen.getByText(/Drop to add the files to/).textContent).toContain('Decisions')
  fireEvent.drop(group, { dataTransfer })
  await waitFor(() =>
    expect(HeldUpload.last.url).toBe('/api/knowledge/files/Decisions/dropped.pdf?onConflict=ask'),
  )
  act(() => {
    HeldUpload.last.responseText = JSON.stringify({
      path: 'Decisions/dropped.pdf',
      kind: 'document',
      replaced: false,
    })
    HeldUpload.last.onload?.()
  })
})
