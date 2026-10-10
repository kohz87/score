import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { AgentSummary, StreamEvent } from '@score/contract'
import { App, appRoutes } from '../../App.tsx'
import { createQueryClient, StreamContext } from '../../data/query-client.ts'
import { createStreamQueryRegistry } from '../../data/resync.ts'
import type { StreamClient, StreamControl } from '../../data/stream.ts'
import { KnowledgeSection } from './KnowledgeSection.tsx'

vi.mock('../../shell/use-needs-you.ts', () => ({ useNeedsYou: vi.fn(() => false) }))

type Call = { method: string; url: string; body: unknown }
let calls: Call[]
let router: ReturnType<typeof createMemoryRouter>
let registry: ReturnType<typeof createStreamQueryRegistry>
/** Responses for the next upload PUTs, in order; then 201. */
let putQueue: Response[]
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
      text: found.textStatus === 'unavailable' ? '' : 'Quarterly budget extracted text',
      entries: null,
    })
  }
  if (p.startsWith('/documents/') && method === 'DELETE') return new Response(null, { status: 204 })
  if (p === '/folders' && method === 'POST') return json({ path: 'x' }, 201)
  if (p === '/move' && method === 'POST')
    return json({ path: 'inbox/renamed.pdf', updatedNotes: 0 })
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
    onControl: (_listener: (control: StreamControl) => void) => () => undefined,
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
const puts = () => calls.filter((c) => c.method === 'PUT')
const file = (name: string, bytes = 8) => new File([new Uint8Array(bytes)], name)
const upload = (files: File[]) =>
  fireEvent.change(screen.getByLabelText('Choose files to upload'), { target: { files } })

test('documents appear in the tree with a type badge and open on their own page', async () => {
  mount()
  const tree = await screen.findByRole('tree', { name: 'Notes' }, { timeout: 10_000 })
  const row = within(tree).getByText('spec.pdf').closest('[role=treeitem]')!
  expect(within(row as HTMLElement).getByText('PDF')).toBeDefined()
  fireEvent.click(row)
  await screen.findByRole('heading', { name: 'spec.pdf' })
  expect(await screen.findByText('Quarterly budget extracted text')).toBeDefined()
  const download = screen.getByRole('link', { name: 'Download' })
  expect(download.getAttribute('href')).toBe('/api/knowledge/files/inbox/spec.pdf?download=1')
  expect(screen.getByText('In the vault history (git)')).toBeDefined()
})

test('a PDF without text says so; an unversioned image says it has no history', async () => {
  mount('/knowledge/inbox/scan.pdf')
  expect(await screen.findByText(/Text is not available for this file/)).toBeDefined()
  cleanup()
  router.dispose()
  registry.dispose()
  mount('/knowledge/inbox/huge.png')
  expect(await screen.findByText(/Not versioned: files over 10 MB/)).toBeDefined()
  expect(screen.getByAltText('Preview of huge.png').getAttribute('src')).toBe(
    '/api/knowledge/files/inbox/huge.png',
  )
})

test('a zip page lists its files', async () => {
  mount('/knowledge/inbox/pack.zip')
  const list = await screen.findByRole('list', { name: 'Files in the zip' })
  expect(within(list).getByText('sub/b.csv')).toBeDefined()
})

test('search results show the document type', async () => {
  mount()
  fireEvent.change(await screen.findByPlaceholderText(/Search notes/), {
    target: { value: 'budget' },
  })
  const results = await screen.findByRole('region', { name: 'Search results' })
  await within(results).findByText('PDF')
})

test('the file manager lists folders, notes and documents with sizes, and opens folders', async () => {
  mount('/knowledge?files=')
  const region = await screen.findByRole(
    'region',
    { name: 'Files in this folder' },
    { timeout: 10_000 },
  )
  expect(within(region).getByText('inbox')).toBeDefined()
  expect(within(region).getByText('Home')).toBeDefined()
  fireEvent.click(within(region).getByRole('button', { name: /inbox/ }))
  const inbox = await screen.findByRole('region', { name: 'Files in this folder' })
  await within(inbox).findByText('spec.pdf')
  expect(within(inbox).getAllByText('2 KB').length).toBeGreaterThan(0)
  expect(within(inbox).getByText('19.1 MB')).toBeDefined()
  expect(within(inbox).getByText('no history')).toBeDefined()
})

test('uploading puts the raw file and reports it', async () => {
  mount('/knowledge?files=inbox')
  await screen.findByRole('region', { name: 'Files in this folder' }, { timeout: 10_000 })
  upload([file('notes.pdf'), file('virus.exe'), file('big.csv', 26 * 1024 * 1024)])
  await screen.findByText(/Added inbox\/notes\.pdf/)
  expect(puts()).toHaveLength(1)
  expect(puts()[0]!.url).toBe('/api/knowledge/files/inbox/notes.pdf?onConflict=ask')
  const banner = screen.getByText(/Not added:/).textContent!
  expect(banner).toContain('virus.exe: this type is not supported')
  expect(banner).toContain('big.csv: larger than 25 MB')
})

test('a name that exists asks keep both or replace, once for the whole batch if ticked', async () => {
  const exists = () =>
    json(
      {
        error: {
          code: 'exists',
          message: 'exists',
          details: {
            existing: [{ path: 'inbox/a.pdf', mtime: '2026-03-04T00:00:00Z', size: 8 }],
          },
        },
      },
      409,
    )
  putQueue = [exists()]
  mount('/knowledge?files=inbox')
  await screen.findByRole('region', { name: 'Files in this folder' }, { timeout: 10_000 })
  upload([file('a.pdf'), file('b.pdf')])
  const dialog = await screen.findByRole('dialog', { name: /already exists/ })
  expect(dialog.textContent).toMatch(/Replace \(existing from/)
  fireEvent.click(within(dialog).getByRole('checkbox', { name: /remaining 1 file/ }))
  fireEvent.click(within(dialog).getByRole('button', { name: 'Keep both' }))
  await screen.findByText(/Added 2 files/)
  expect(puts().map((c) => c.url)).toEqual([
    '/api/knowledge/files/inbox/a.pdf?onConflict=ask',
    '/api/knowledge/files/inbox/a.pdf?onConflict=keep',
    '/api/knowledge/files/inbox/b.pdf?onConflict=keep',
  ])
})

test('Skip leaves the existing file alone', async () => {
  putQueue = [
    json(
      {
        error: {
          code: 'exists',
          message: 'x',
          details: { existing: [{ path: 'inbox/a.pdf', mtime: '2026-03-04T00:00:00Z', size: 8 }] },
        },
      },
      409,
    ),
  ]
  mount('/knowledge?files=inbox')
  await screen.findByRole('region', { name: 'Files in this folder' }, { timeout: 10_000 })
  upload([file('a.pdf')])
  fireEvent.click(await screen.findByRole('button', { name: 'Skip' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(puts()).toHaveLength(1)
})

function zipPreview() {
  return json({
    entries: [
      { path: 'a.md', size: 3, action: 'extract', reason: null },
      { path: 'b.csv', size: 40, action: 'extract', reason: null },
      { path: 'x.exe', size: 2, action: 'skip', reason: 'type not supported' },
    ],
    more: false,
    extractCount: 2,
  })
}

test('a zip asks: unzip into an editable folder after previewing, or keep as a zip', async () => {
  putQueue = [zipPreview()]
  mount('/knowledge?files=inbox')
  await screen.findByRole('region', { name: 'Files in this folder' }, { timeout: 10_000 })
  upload([file('pack.zip')])
  const dialog = await screen.findByRole('dialog', { name: /Zip file: pack\.zip/ })
  expect(puts()[0]!.url).toContain('mode=preview')
  const list = within(dialog).getByRole('list', { name: 'Files in the zip' })
  expect(within(list).getByText(/skipped: type not supported/)).toBeDefined()
  expect(within(dialog).getByText(/2 files will be added; 1 will be skipped/)).toBeDefined()
  const folder = within(dialog).getByLabelText('Folder') as HTMLInputElement
  expect(folder.value).toBe('inbox/pack')
  fireEvent.change(folder, { target: { value: 'inbox/renamed' } })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Unzip' }))
  await screen.findByText(/Unzipped 2 files into inbox\/renamed \(1 skipped\)/)
  expect(puts()[1]!.url).toBe(
    '/api/knowledge/files/inbox/pack.zip?mode=unzip&folder=inbox%2Frenamed&onConflict=ask',
  )
})

test('keeping a zip stores it as a file', async () => {
  putQueue = [zipPreview()]
  mount('/knowledge?files=inbox')
  await screen.findByRole('region', { name: 'Files in this folder' }, { timeout: 10_000 })
  upload([file('pack.zip')])
  const dialog = await screen.findByRole('dialog', { name: /Zip file/ })
  fireEvent.click(within(dialog).getByRole('radio', { name: /Keep as a zip/ }))
  fireEvent.click(within(dialog).getByRole('button', { name: 'Keep as a zip' }))
  await screen.findByText(/Added inbox\/pack\.zip/)
  expect(puts()[1]!.url).toBe('/api/knowledge/files/inbox/pack.zip?onConflict=ask')
})

test('a zip the server refuses is reported, with its reason', async () => {
  putQueue = [
    json({ error: { code: 'zip_limits', message: 'The zip holds more than 1000 entries' } }, 413),
  ]
  mount('/knowledge?files=inbox')
  await screen.findByRole('region', { name: 'Files in this folder' }, { timeout: 10_000 })
  upload([file('many.zip')])
  await screen.findByText(/many\.zip: The zip holds more than 1000 entries/)
})

test('dropping files on a folder in the tree uploads into that folder', async () => {
  mount()
  const tree = await screen.findByRole('tree', { name: 'Notes' }, { timeout: 10_000 })
  const folder = within(tree).getByText('inbox').closest('[role=treeitem]')!
  fireEvent.drop(folder, { dataTransfer: { types: ['Files'], files: [file('dropped.pdf')] } })
  await screen.findByText(/Added inbox\/dropped\.pdf/)
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

test('a new folder is created from the file manager', async () => {
  mount('/knowledge?files=inbox')
  fireEvent.click(await screen.findByRole('button', { name: 'New folder' }, { timeout: 10_000 }))
  const dialog = await screen.findByRole('dialog', { name: 'New folder' })
  const input = within(dialog).getByLabelText('Folder path') as HTMLInputElement
  expect(input.value).toBe('inbox/')
  fireEvent.change(input, { target: { value: 'inbox/contracts' } })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Create folder' }))
  await waitFor(() =>
    expect(calls.find((c) => c.url === '/api/knowledge/folders')?.body).toEqual({
      path: 'inbox/contracts',
    }),
  )
})

test('Settings › Knowledge shows how much the files take', async () => {
  const queryClient = createQueryClient()
  render(
    <QueryClientProvider client={queryClient}>
      <KnowledgeSection />
    </QueryClientProvider>,
  )
  expect(await screen.findByText(/4 files, 3\.0 MB/)).toBeDefined()
  void act
})
