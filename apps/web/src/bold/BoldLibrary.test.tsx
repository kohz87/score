import type { AgentSummary, KnowledgeNote, KnowledgeNoteSummary } from '@score/contract'
import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createQueryClient, StreamContext } from '../data/query-client.ts'
import type { StreamClient } from '../data/stream.ts'
import { BoldLibrary } from './BoldLibrary.tsx'

class HeldUpload {
  static last: HeldUpload
  upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null }
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  status = 200
  responseText = ''
  responseType = ''
  url = ''
  constructor() {
    HeldUpload.last = this
  }
  open(_method: string, url: string) {
    this.url = url
  }
  setRequestHeader() {}
  send() {}
}

const reviewer: AgentSummary = {
  id: 'reviewer',
  name: 'reviewer',
  role: 'Reviews changes',
  style: { color: '#FFB61E', shape: 'diamond' },
  status: 'idle',
  activity: null,
  model: { id: 'fake-model', label: 'Demo model' },
  served: true,
}

const notes: KnowledgeNoteSummary[] = [
  {
    path: 'Decisions/Event cursors.md',
    title: 'Event cursors',
    mtime: '2026-10-24T09:00:00Z',
    lastAuthor: { agentId: 'reviewer' },
  },
  {
    path: 'Decisions/Source.md',
    title: 'Source',
    mtime: '2026-10-24T08:00:00Z',
    lastAuthor: 'you',
  },
]

function note(path: string): KnowledgeNote {
  return {
    path,
    title: path === notes[0]!.path ? 'Event cursors' : 'Source',
    frontmatter: { status: 'draft' },
    body:
      path === notes[0]!.path
        ? '# Event cursors\n\nPage by cursor.\n'
        : '# Source\n\nSee [[Event cursors]].\n',
    etag: `etag-${path}`,
    mtime: '2026-10-24T09:00:00Z',
    links:
      path === notes[1]!.path
        ? [{ target: 'Event cursors', path: notes[0]!.path }]
        : [{ target: 'Missing', path: null }],
    backlinks: path === notes[0]!.path ? [{ path: notes[1]!.path, title: 'Source' }] : [],
    lastAuthor: path === notes[0]!.path ? { agentId: 'reviewer' } : 'you',
    versioned: true,
    history: 'unchanged',
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

let treeError = false
let entries: KnowledgeNoteSummary[] = notes
let folders = ['Decisions']
let searchItems: Array<Record<string, unknown>> = []

function respond(input: string, init: RequestInit = {}): Response {
  const url = new URL(input, 'http://score.test')
  const path = url.pathname
  const method = (init.method ?? 'GET').toUpperCase()
  if (path === '/api/knowledge')
    return json({
      vault: '/vault',
      notes: entries.length,
      gitAvailable: true,
      agentAccess: true,
      memoryNotes: true,
      documents: 0,
      documentBytes: 0,
      moveIssue: null,
    })
  if (path === '/api/knowledge/tree') {
    if (treeError) return json({ error: { code: 'failed', message: 'no' } }, 500)
    return json({
      folders,
      notes: entries,
      documents: [],
    })
  }
  if (path === '/api/knowledge/search') return json({ items: searchItems })
  if (path.startsWith('/api/knowledge/notes/')) {
    if (method === 'DELETE') return new Response(null, { status: 204 })
    const rest = decodeURIComponent(path.slice('/api/knowledge/notes/'.length))
    if (rest.endsWith('/history')) return json({ items: [] })
    const found = entries.find((item) => item.path === rest)
    if (!found) return json({ error: { code: 'not_found', message: 'gone' } }, 404)
    return json(note(rest))
  }
  if (path === '/api/agents') return json({ asOfSeq: 0, items: [reviewer] })
  return json({ error: { code: 'not_found', message: 'no' } }, 404)
}

let router: ReturnType<typeof createMemoryRouter>
let client: ReturnType<typeof createQueryClient>

function mount(openPath: string | null = null) {
  const queryClient = createQueryClient()
  client = queryClient
  queryClient.setDefaultOptions({ queries: { retry: false } })
  const stream = {
    subscribe: () => () => undefined,
    onControl: () => () => undefined,
  }
  router = createMemoryRouter([
    { path: '/', element: <BoldLibrary agents={[reviewer]} openPath={openPath} /> },
  ])
  render(
    <QueryClientProvider client={queryClient}>
      <StreamContext value={{ client: stream as unknown as StreamClient, queries: {} as never }}>
        <RouterProvider router={router} />
      </StreamContext>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  treeError = false
  entries = notes
  searchItems = []
  folders = ['Decisions']
  sessionStorage.clear()
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string | URL | Request, init?: RequestInit) =>
      Promise.resolve(respond(String(input), init)),
    ),
  )
})

afterEach(() => {
  cleanup()
  router?.dispose()
  vi.unstubAllGlobals()
})

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

test('an outside edit gets its own wording in the byline', async () => {
  entries = [{ ...notes[0]!, lastAuthor: 'outside' }]
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
  searchItems = [
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
  entries = []
  mount()
  expect(await screen.findByText('The Library is empty')).toBeDefined()
  expect(screen.getByText('No notes yet. Start one below or upload a file.')).toBeDefined()
  expect(screen.queryByRole('textbox', { name: /Contents of/ })).toBeNull()
})

test('a tree error is shown in words', async () => {
  treeError = true
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

test('folders collapse, empty and nested folders show, and New note starts in the picked folder', async () => {
  folders = ['Decisions', 'Decisions/Archive', 'Empty']
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
  folders = ['Decisions', 'Empty']
  mount()
  const nav = await screen.findByRole('navigation', { name: 'Library notes' })
  fireEvent.click(await within(nav).findByRole('button', { name: /^Empty/ }))
  fireEvent.click(within(nav).getByRole('button', { name: 'Notes' }))
  fireEvent.click(within(nav).getByRole('button', { name: /New note/ }))
  expect(((await screen.findByLabelText('Path in Knowledge')) as HTMLInputElement).value).toBe('')
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  fireEvent.click(within(nav).getByRole('button', { name: /^Empty/ }))
  folders = ['Decisions']
  await act(async () => {
    await client.invalidateQueries()
  })
  await waitFor(() => expect(within(nav).queryByRole('button', { name: /^Empty/ })).toBeNull())
  fireEvent.click(within(nav).getByRole('button', { name: /New note/ }))
  expect(((await screen.findByLabelText('Path in Knowledge')) as HTMLInputElement).value).toBe('')
})

test('a note opened from Search expands its folded folder chain', async () => {
  folders = ['Decisions']
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
