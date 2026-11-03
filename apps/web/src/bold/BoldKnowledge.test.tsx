import type { AgentSummary, KnowledgeNote, KnowledgeNoteSummary } from '@score/contract'
import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, expect, onTestFinished, test, vi } from 'vitest'
import { createQueryClient, StreamContext } from '../data/query-client.ts'
import { createStreamQueryRegistry } from '../data/resync.ts'
import { createStreamClient } from '../data/stream.ts'
import { BoldKnowledgePage } from './BoldKnowledge.tsx'

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
  if (path === '/api/knowledge/folders/move') {
    const body = JSON.parse(String(init.body)) as { to: string }
    return json({ path: body.to, moved: 2, updatedNotes: 1, skipped: [], leftBehind: [] })
  }
  if (path.startsWith('/api/knowledge/folders/') && method === 'DELETE')
    return url.searchParams.get('contents') === '1'
      ? json({ deleted: 2, leftBehind: [] })
      : new Response(null, { status: 204 })
  if (path === '/api/agents') return json({ asOfSeq: 0, items: [reviewer] })
  if (path === '/api/rooms')
    return json({
      asOfSeq: 0,
      rooms: [
        {
          id: 'team-1',
          name: 'Team room',
          role: 'team',
          kind: 'room',
          leadAgentId: null,
          members: ['reviewer'],
          unread: 0,
          activeAgents: [],
          channels: [],
        },
      ],
      directs: [],
      projects: [],
    })
  if (path === '/api/agents/reviewer/knowledge') return json({ enabled: true })
  return json({ error: { code: 'not_found', message: 'no' } }, 404)
}

let router: ReturnType<typeof createMemoryRouter>

function mount(at = '/b/knowledge') {
  const queryClient = createQueryClient()
  queryClient.setDefaultOptions({ queries: { retry: false } })
  class Source extends EventTarget {
    close() {}
  }
  const client = createStreamClient({ EventSourceImpl: Source })
  const queries = createStreamQueryRegistry(queryClient, client)
  onTestFinished(() => {
    queries.dispose()
    client.close()
  })
  router = createMemoryRouter(
    [
      { path: '/b/knowledge', element: <BoldKnowledgePage /> },
      { path: '/b', element: <p>The team room</p> },
    ],
    { initialEntries: [at] },
  )
  render(
    <QueryClientProvider client={queryClient}>
      <StreamContext value={{ client, queries }}>
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
  localStorage.clear()
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

test('three columns: folders with counts, the note list and the first note open', async () => {
  mount()
  const rail = await screen.findByRole('complementary', { name: 'Folders' })
  expect(within(rail).getByRole('heading', { name: 'Knowledge' })).toBeDefined()
  expect(within(rail).getByRole('button', { name: /All notes\s*2/ })).toBeDefined()
  expect(within(rail).getByRole('button', { name: /Decisions\s*2/ })).toBeDefined()
  expect(within(rail).getByRole('button', { name: /Documents\s*0/ })).toBeDefined()
  expect(await within(rail).findByText('reviewer')).toBeDefined()
  expect(await screen.findByLabelText('Contents of Decisions/Event cursors.md')).toBeDefined()
  expect(screen.getByRole('button', { name: 'Share to a chat' })).toBeDefined()
  expect(screen.getByRole('button', { name: 'Edit' })).toBeDefined()
  expect(screen.getByRole('button', { name: 'New note' })).toBeDefined()
})

test('?note= opens that note, and picking another keeps the address in step', async () => {
  mount('/b/knowledge?note=Decisions%2FSource.md')
  expect(await screen.findByLabelText('Contents of Decisions/Source.md')).toBeDefined()
  fireEvent.click(
    within(screen.getByRole('navigation', { name: 'Library notes' })).getByRole('button', {
      name: /Event cursors/,
    }),
  )
  expect(await screen.findByLabelText('Contents of Decisions/Event cursors.md')).toBeDefined()
  await waitFor(() =>
    expect(router.state.location.search).toBe('?note=Decisions%2FEvent+cursors.md'),
  )
})

test('search lists hits and opens one', async () => {
  searchItems = [
    {
      kind: 'note',
      path: 'Decisions/Source.md',
      title: 'Source',
      snippet: 'See [[Event cursors]]',
      type: null,
    },
  ]
  mount()
  await screen.findByLabelText('Contents of Decisions/Event cursors.md')
  fireEvent.change(screen.getByPlaceholderText('Search'), { target: { value: 'cursor' } })
  const results = await screen.findByRole('region', { name: 'Search results' })
  fireEvent.click(await within(results).findByRole('button', { name: /Source/ }))
  expect(await screen.findByLabelText('Contents of Decisions/Source.md')).toBeDefined()
})

test('Share to a chat leaves a note reference in the team room draft', async () => {
  mount()
  await screen.findByLabelText('Contents of Decisions/Event cursors.md')
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Share to a chat' }).hasAttribute('disabled')).toBe(
      false,
    ),
  )
  fireEvent.click(screen.getByRole('button', { name: 'Share to a chat' }))
  expect(await screen.findByText('The team room')).toBeDefined()
  expect(localStorage.getItem('score.chat.draft.team-1')).toContain('[[Decisions/Event cursors]]')
})

test('on a phone the folders are a chip row, a note opens full width and Back returns to the list', async () => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('max-width'),
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }))
  mount()
  const rail = await screen.findByRole('complementary', { name: 'Folders' })
  expect(rail).toBeDefined()
  // The list shows first; no note is open until one is tapped.
  expect(screen.queryByLabelText('Contents of Decisions/Event cursors.md')).toBeNull()
  fireEvent.click(await screen.findByRole('button', { name: /Source/ }))
  expect(await screen.findByLabelText('Contents of Decisions/Source.md')).toBeDefined()
  expect(screen.queryByRole('complementary', { name: 'Folders' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: /Back to the notes/ }))
  expect(await screen.findByRole('complementary', { name: 'Folders' })).toBeDefined()
  expect(screen.queryByLabelText('Contents of Decisions/Source.md')).toBeNull()
})
