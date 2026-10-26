import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { AgentSummary } from '@score/contract'
import { App, appRoutes } from '../../App.tsx'
import { createQueryClient, StreamContext } from '../../data/query-client.ts'
import { createStreamQueryRegistry } from '../../data/resync.ts'
import type { StreamClient } from '../../data/stream.ts'

vi.mock('../../shell/use-needs-you.ts', () => ({ useNeedsYou: vi.fn(() => false) }))

type Call = { method: string; url: string; body: unknown }
let calls: Call[]
let router: ReturnType<typeof createMemoryRouter>
let registry: ReturnType<typeof createStreamQueryRegistry>
/** Responses for the next upload PUTs, in order; then 201. */
let putQueue: Response[]
/** While set, every PUT waits for it: the upload is "sent" and the server is still working. */
/** Responses for the next files-from-staged POSTs, in order; then 201. */
const stagedQueue: Response[] = []
let putGate: Promise<void> | null = null
let documents: Array<Record<string, unknown>>

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const builder: AgentSummary = {
  id: 'builder',
  name: 'Builder',
  role: 'Builds it',
  style: { color: '#19c39a', shape: 'triangle' },
  status: 'idle',
  activity: null,
  model: { id: 'm', label: 'M' },
  served: true,
}
const doc = (path: string, extra: Record<string, unknown> = {}) => ({
  path,
  type: 'pdf',
  size: 2048,
  mtime: '2026-01-01T00:00:00Z',
  lastAuthor: 'you',
  versioned: true,
  textStatus: 'indexed',
  ...extra,
})

function respond(input: string, init: RequestInit = {}): Response {
  const url = new URL(input, 'http://score.test')
  const method = (init.method ?? 'GET').toUpperCase()
  calls.push({
    method,
    url: url.pathname + url.search,
    body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body,
  })
  const p = url.pathname.replace('/api/knowledge', '')
  if (p === '' && method === 'GET')
    return json({
      vault: '/vault',
      notes: 1,
      gitAvailable: true,
      agentAccess: true,
      documents: documents.length,
      documentBytes: 3 * 1024 * 1024,
    })
  if (p === '/tree')
    return json({
      folders: ['inbox', 'inbox/empty'],
      notes: [{ path: 'Home.md', title: 'Home', mtime: '2026-01-01T00:00:00Z', lastAuthor: 'you' }],
      documents,
    })
  if (p === '/search')
    return json({
      items: [
        {
          path: 'inbox/spec.pdf',
          title: 'spec.pdf',
          snippet: 'the [[budget]] line',
          kind: 'document',
          type: 'pdf',
        },
      ],
    })
  if (p.startsWith('/documents/') && method === 'GET') {
    const path = decodeURIComponent(p.slice('/documents/'.length))
    const found = documents.find((item) => item.path === path)
    if (!found) return json({ error: { code: 'not_found', message: 'gone' } }, 404)
    if (path.endsWith('.zip'))
      return json({
        ...found,
        text: '',
        entries: [
          { path: 'a.md', size: 3 },
          { path: 'sub/b.csv', size: 40 },
        ],
      })
    return json({
      ...found,
      text:
        found.textStatus === 'unavailable' || found.textStatus === 'too_large'
          ? ''
          : 'Quarterly budget extracted text',
      entries: null,
    })
  }
  if (p.startsWith('/documents/') && method === 'DELETE') return new Response(null, { status: 204 })
  if (p === '/export/summary' && method === 'POST')
    return json({ files: 7, bytes: 5 * 1024 * 1024, label: 'vault' })
  if (p === '/export' && method === 'POST')
    return new Response(new Uint8Array([0x50, 0x4b, 5, 6]), {
      headers: {
        'content-type': 'application/zip',
        'content-disposition': 'attachment; filename="knowledge-vault-2026-10-10.zip"',
      },
    })
  if (p === '/folders' && method === 'POST') return json({ path: 'x' }, 201)
  if (p === '/move' && method === 'POST')
    return json({ path: 'inbox/renamed.pdf', updatedNotes: 0 })
  if (p === '/files-from-staged' && method === 'POST') {
    const next = stagedQueue.shift()
    if (next) return next
    const body = JSON.parse(String(init.body)) as { path: string; mode: string; folder?: string }
    return body.mode === 'unzip'
      ? json({ folder: body.folder, written: ['a.md', 'b.csv'], skipped: [] }, 201)
      : json({ path: body.path, kind: 'document', replaced: false }, 201)
  }
  if (p.startsWith('/files/') && method === 'PUT') {
    const next = putQueue.shift()
    if (next) return next
    const path = decodeURIComponent(p.slice('/files/'.length))
    if (url.searchParams.get('mode') === 'unzip')
      return json(
        {
          folder: url.searchParams.get('folder'),
          written: ['a.md', 'b.csv'],
          skipped: [{ path: 'x.exe', reason: 'type not supported' }],
        },
        201,
      )
    return json({ path, kind: 'document', replaced: false }, 201)
  }
  return json({ error: { code: 'not_found', message: 'no' } }, 404)
}

beforeEach(() => {
  calls = []
  putQueue = []
  putGate = null
  documents = [
    doc('inbox/spec.pdf'),
    doc('inbox/scan.pdf', { textStatus: 'unavailable' }),
    doc('inbox/pack.zip', { type: 'zip', textStatus: 'none' }),
    doc('inbox/huge.png', {
      type: 'image',
      textStatus: 'none',
      versioned: false,
      size: 20_000_000,
    }),
  ]
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      if (input === '/api/agents') return json({ asOfSeq: 0, items: [builder] })
      if (putGate && init?.method === 'PUT') await putGate
      return respond(input, init)
    }),
  )
})
afterEach(() => {
  cleanup()
  router?.dispose()
  registry?.dispose()
  vi.unstubAllGlobals()
})

function mount(url = '/knowledge') {
  const queryClient = createQueryClient()
  queryClient.setDefaultOptions({ queries: { retry: false } })
  const stream = {
    subscribe: () => () => undefined,
    onControl: () => () => undefined,
  }
  registry = createStreamQueryRegistry(queryClient, stream)
  router = createMemoryRouter(appRoutes, { initialEntries: [url] })
  render(
    <QueryClientProvider client={queryClient}>
      <StreamContext value={{ client: stream as unknown as StreamClient, queries: registry }}>
        <App router={router} />
      </StreamContext>
    </QueryClientProvider>,
  )
}

test('a PDF without text says so; an unversioned image says it has no history', async () => {
  mount('/knowledge/inbox/scan.pdf')
  expect(await screen.findByText(/Text is not available for this file/)).toBeDefined()
  cleanup()
  router.dispose()
  registry.dispose()
  mount('/knowledge/inbox/huge.png')
  expect(await screen.findByText(/Not versioned: stored without history/)).toBeDefined()
  expect(screen.getByAltText('Preview of huge.png').getAttribute('src')).toBe(
    '/api/knowledge/files/inbox/huge.png',
  )
})

test('a document over 25 MB says it is too large to preview and offers the download', async () => {
  documents.push(doc('inbox/big.pdf', { textStatus: 'too_large', size: 100 * 1024 * 1024 }))
  mount('/knowledge/inbox/big.pdf')
  expect(
    await screen.findByText('Too large to preview (over 25 MB). Download it to open it.'),
  ).toBeDefined()
  expect(screen.getByText('Not indexed (over 25 MB)')).toBeDefined()
  expect(screen.getByRole('link', { name: /Download/ }).getAttribute('href')).toBe(
    '/api/knowledge/files/inbox/big.pdf?download=1',
  )
})

test('an image over 25 MB shows the notice and no picture', async () => {
  documents.push(
    doc('inbox/big.png', { type: 'image', textStatus: 'too_large', size: 100 * 1024 * 1024 }),
  )
  mount('/knowledge/inbox/big.png')
  expect(
    await screen.findByText('Too large to preview (over 25 MB). Download it to open it.'),
  ).toBeDefined()
  expect(screen.queryByAltText('Preview of big.png')).toBeNull()
})

test('a zip page lists its files', async () => {
  mount('/knowledge/inbox/pack.zip')
  const list = await screen.findByRole('list', { name: 'Files in the zip' })
  expect(within(list).getByText('sub/b.csv')).toBeDefined()
})

test('delete asks first, and only then removes the document', async () => {
  mount('/knowledge/inbox/spec.pdf')
  fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))
  const dialog = await screen.findByRole('dialog', { name: /Delete spec\.pdf\?/ })
  expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete file' }))
  await waitFor(() =>
    expect(
      calls.some(
        (c) => c.method === 'DELETE' && c.url === '/api/knowledge/documents/inbox/spec.pdf',
      ),
    ).toBe(true),
  )
})

test('moving a document keeps its type and offers no link update', async () => {
  mount('/knowledge/inbox/spec.pdf')
  fireEvent.click(await screen.findByRole('button', { name: 'Rename or move' }))
  const dialog = await screen.findByRole('dialog', { name: /Rename or move spec\.pdf/ })
  expect(within(dialog).queryByRole('checkbox')).toBeNull()
  fireEvent.change(within(dialog).getByLabelText('New path'), {
    target: { value: 'inbox/renamed.pdf' },
  })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Move' }))
  await waitFor(() =>
    expect(calls.some((c) => c.method === 'POST' && c.url === '/api/knowledge/move')).toBe(true),
  )
  expect(calls.find((c) => c.url === '/api/knowledge/move')!.body).toEqual({
    from: 'inbox/spec.pdf',
    to: 'inbox/renamed.pdf',
    updateLinks: true,
  })
})
