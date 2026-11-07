import type { AgentSummary, KnowledgeNote, KnowledgeNoteSummary } from '@score/contract'
import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, vi } from 'vitest'
import { createQueryClient, StreamContext } from '../data/query-client.ts'
import type { StreamClient } from '../data/stream.ts'
import { BoldLibrary } from './BoldLibrary.tsx'

export class HeldUpload {
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

export const notes: KnowledgeNoteSummary[] = [
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

type LibraryState = {
  treeError: boolean
  entries: KnowledgeNoteSummary[]
  folders: string[]
  searchItems: Array<Record<string, unknown>>
  client: ReturnType<typeof createQueryClient> | null
}

export const libraryState: LibraryState = {
  treeError: false,
  entries: notes,
  folders: ['Decisions'],
  searchItems: [],
  client: null,
}

function respond(input: string, init: RequestInit = {}): Response {
  const url = new URL(input, 'http://score.test')
  const path = url.pathname
  const method = (init.method ?? 'GET').toUpperCase()
  if (path === '/api/knowledge')
    return json({
      vault: '/vault',
      notes: libraryState.entries.length,
      gitAvailable: true,
      agentAccess: true,
      memoryNotes: true,
      documents: 0,
      documentBytes: 0,
      moveIssue: null,
    })
  if (path === '/api/knowledge/tree') {
    if (libraryState.treeError) return json({ error: { code: 'failed', message: 'no' } }, 500)
    return json({
      folders: libraryState.folders,
      notes: libraryState.entries,
      documents: [],
    })
  }
  if (path === '/api/knowledge/search') return json({ items: libraryState.searchItems })
  if (path.startsWith('/api/knowledge/notes/')) {
    if (method === 'DELETE') return new Response(null, { status: 204 })
    const rest = decodeURIComponent(path.slice('/api/knowledge/notes/'.length))
    if (rest.endsWith('/history')) return json({ items: [] })
    const found = libraryState.entries.find((item) => item.path === rest)
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
  return json({ error: { code: 'not_found', message: 'no' } }, 404)
}

let router: ReturnType<typeof createMemoryRouter>

export function mount(openPath: string | null = null, page = false) {
  const queryClient = createQueryClient()
  libraryState.client = queryClient
  queryClient.setDefaultOptions({ queries: { retry: false } })
  const stream = {
    subscribe: () => () => undefined,
    onControl: () => () => undefined,
  }
  router = createMemoryRouter([
    { path: '/', element: <BoldLibrary agents={[reviewer]} openPath={openPath} page={page} /> },
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
  libraryState.treeError = false
  libraryState.entries = notes
  libraryState.searchItems = []
  libraryState.folders = ['Decisions']
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
