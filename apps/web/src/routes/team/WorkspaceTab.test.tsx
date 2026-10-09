import { EditorView } from '@codemirror/view'
import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createQueryClient } from '../../data/query-client.ts'
import { WorkspaceTab } from './WorkspaceTab.tsx'

type Call = { method: string; url: string; body: unknown; headers: Headers }
let calls: Call[]
let info: { root: string | null; available: boolean; reason: string | null }
let files: Map<string, string>
let dirs: Map<string, { name: string; kind: 'file' | 'dir' }[]>
let etag: string
let saveStatus: 200 | 412
let removeNotEmpty: boolean

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function handler(input: string, init: RequestInit = {}): Response {
  const url = new URL(input, 'http://score.test')
  const method = (init.method ?? 'GET').toUpperCase()
  const path = url.searchParams.get('path') ?? ''
  const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body
  calls.push({ method, url: url.pathname + url.search, body, headers: new Headers(init.headers) })
  const tail = url.pathname.replace('/api/agents/builder/workspace', '')
  if (tail === '' && method === 'GET') return json(200, info)
  if (tail === '/root' && method === 'PUT') {
    info = { root: body.path, available: true, reason: null }
    return json(200, info)
  }
  if (tail === '/tree')
    return json(200, {
      entries: (dirs.get(path) ?? []).map((e) => ({
        ...e,
        size: 1,
        mtime: '2026-01-01T00:00:00.000Z',
        hidden: e.name.startsWith('.'),
      })),
    })
  if (tail === '/file' && method === 'GET') {
    if (path.endsWith('.bin')) return json(200, { binary: true, size: 2048, reason: 'binary' })
    return new Response(files.get(path) ?? '', {
      headers: { 'content-type': 'text/plain; charset=utf-8', etag: `"${etag}"` },
    })
  }
  if (tail === '/file' && method === 'PUT') {
    if (saveStatus === 412)
      return json(412, {
        error: { code: 'precondition_failed', message: 'changed', details: { etag: 'disk2' } },
      })
    files.set(path, body.content)
    etag = 'new-etag'
    return json(200, { etag })
  }
  if (tail === '/entries' && method === 'POST') return json(201, {})
  if (tail === '/entries' && method === 'DELETE') {
    if (removeNotEmpty && url.searchParams.get('recursive') !== '1')
      return json(409, { error: { code: 'not_empty', message: 'The folder is not empty' } })
    return json(200, {})
  }
  if (tail === '/upload') return json(201, { path, size: 3 })
  return json(404, { error: { code: 'not_found', message: 'no' } })
}

beforeEach(() => {
  calls = []
  info = { root: '/work/project', available: true, reason: null }
  files = new Map([
    ['README.md', 'hello'],
    ['src/main.ts', 'export {}'],
  ])
  dirs = new Map([
    [
      '',
      [
        { name: 'src', kind: 'dir' },
        { name: 'README.md', kind: 'file' },
        { name: 'logo.png', kind: 'file' },
        { name: 'data.bin', kind: 'file' },
      ],
    ],
    ['src', [{ name: 'main.ts', kind: 'file' }]],
  ])
  etag = 'etag-1'
  saveStatus = 200
  removeNotEmpty = false
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => handler(input, init)),
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function mount() {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <WorkspaceTab agentId="builder" agentName="Builder" />
    </QueryClientProvider>,
  )
}
const view = () => EditorView.findFromDOM(document.querySelector<HTMLElement>('.cm-editor')!)!
function setText(text: string) {
  const editor = view()
  act(() => {
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: text } })
  })
}
const treeCalls = () => calls.filter((c) => c.url.includes('/workspace/tree')).map((c) => c.url)

test('an unavailable workspace shows the reason and lets the folder be set', async () => {
  info = { root: null, available: false, reason: 'No working folder is set for this agent' }
  mount()
  expect(await screen.findByText('No working folder is set for this agent')).toBeTruthy()
  fireEvent.change(screen.getByLabelText('Folder on this computer'), {
    target: { value: '/work/project' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Use this folder' }))
  expect(await screen.findByRole('tree', { name: 'Files' })).toBeTruthy()
  const put = calls.find((c) => c.method === 'PUT' && c.url.endsWith('/root'))!
  expect(put.body).toEqual({ path: '/work/project' })
})

test('a refused folder shows the server reason', async () => {
  info = { root: null, available: false, reason: 'unset' }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) =>
      init?.method === 'PUT'
        ? json(409, {
            error: {
              code: 'workspace_unavailable',
              message: 'The home folder cannot be a workspace',
            },
          })
        : handler(input, init),
    ),
  )
  mount()
  fireEvent.change(await screen.findByLabelText('Folder on this computer'), {
    target: { value: '/home/me' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Use this folder' }))
  expect((await screen.findByRole('alert')).textContent).toContain(
    'The home folder cannot be a workspace',
  )
})

test('the tree loads lazily: a folder is listed only when opened', async () => {
  mount()
  await screen.findByRole('treeitem', { name: /src/ })
  expect(treeCalls()).toEqual(['/api/agents/builder/workspace/tree?path='])
  fireEvent.click(screen.getByRole('treeitem', { name: /src/ }))
  await screen.findByRole('treeitem', { name: /main\.ts/ })
  expect(treeCalls()).toContain('/api/agents/builder/workspace/tree?path=src')
  expect(screen.getByRole('treeitem', { name: /src/ }).getAttribute('aria-expanded')).toBe('true')
})

test(
  'open, edit and save sends the loaded etag; the button disables when clean',
  { timeout: 20_000 },
  async () => {
    mount()
    fireEvent.click(await screen.findByRole('treeitem', { name: /README\.md/ }))
    await screen.findByLabelText('Contents of README.md', {}, { timeout: 10_000 })
    expect(view().state.doc.toString()).toBe('hello')
    const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    setText('hello world')
    expect(save.disabled).toBe(false)
    fireEvent.click(save)
    await screen.findByText('Saved.')
    const put = calls.find((c) => c.method === 'PUT' && c.url.includes('/file'))!
    expect(put.body).toEqual({ content: 'hello world', etag: 'etag-1' })
    expect(put.url).toContain('path=README.md')
  },
)

test(
  'a stale etag shows the conflict banner; reload takes the disk version, overwrite retries with its etag',
  { timeout: 20_000 },
  async () => {
    mount()
    fireEvent.click(await screen.findByRole('treeitem', { name: /README\.md/ }))
    await screen.findByLabelText('Contents of README.md', {}, { timeout: 10_000 })
    setText('mine')
    saveStatus = 412
    files.set('README.md', 'on disk')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    const banner = await screen.findByText('Changed on disk.')
    expect(banner).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Compare' }))
    expect(((await screen.findByLabelText('On disk')) as HTMLTextAreaElement).value).toBe('on disk')
    expect((screen.getByLabelText('My version') as HTMLTextAreaElement).value).toBe('mine')
    saveStatus = 200
    fireEvent.click(screen.getByRole('button', { name: 'Overwrite with my version' }))
    await screen.findByText('Saved.')
    const puts = calls.filter((c) => c.method === 'PUT' && c.url.includes('/file'))
    expect(puts.at(-1)!.body).toEqual({ content: 'mine', etag: 'disk2' })

    // Reload path.
    setText('again')
    saveStatus = 412
    files.set('README.md', 'on disk')
    etag = 'disk2'
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByText('Changed on disk.')
    fireEvent.click(screen.getByRole('button', { name: 'Reload from disk' }))
    await waitFor(() => expect(view().state.doc.toString()).toBe('on disk'))
  },
)

test(
  'a Markdown file has a rendered Preview without raw HTML; code files have none',
  { timeout: 20_000 },
  async () => {
    files.set('README.md', '# Title\n\nsome **bold** <script>alert(1)</script>')
    mount()
    fireEvent.click(await screen.findByRole('treeitem', { name: /README\.md/ }))
    await screen.findByLabelText('Contents of README.md', {}, { timeout: 10_000 })
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    const preview = screen.getByLabelText('Preview of README.md')
    expect(within(preview).getByRole('heading', { name: 'Title' })).toBeTruthy()
    expect(preview.querySelector('strong')?.textContent).toBe('bold')
    expect(preview.querySelector('script')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    await screen.findByLabelText('Contents of README.md')
    fireEvent.click(screen.getByRole('treeitem', { name: /src/ }))
    fireEvent.click(await screen.findByRole('treeitem', { name: /main\.ts/ }))
    await screen.findByLabelText('Contents of src/main.ts')
    expect(screen.queryByRole('button', { name: 'Preview' })).toBeNull()
  },
)

test('images preview by URL and binaries offer a download', async () => {
  mount()
  fireEvent.click(await screen.findByRole('treeitem', { name: /logo\.png/ }))
  const img = (await screen.findByRole('img')) as HTMLImageElement
  expect(img.getAttribute('src')).toBe('/api/agents/builder/workspace/file?path=logo.png')
  cleanup()
  mount()
  fireEvent.click(await screen.findByRole('treeitem', { name: /data\.bin/ }))
  await screen.findByText(/This is not a text file/)
  expect(screen.getByRole('link', { name: 'Download' }).getAttribute('href')).toContain(
    'download=1',
  )
})

test('new file is created inside the selected folder', async () => {
  mount()
  fireEvent.click(await screen.findByRole('treeitem', { name: /src/ }))
  fireEvent.click(screen.getByRole('button', { name: 'New file' }))
  fireEvent.change(screen.getByLabelText(/New file in src/), { target: { value: 'util.ts' } })
  fireEvent.click(
    within(screen.getByRole('form', { name: 'new-file' })).getByRole('button', { name: 'Create' }),
  )
  await waitFor(() =>
    expect(calls.find((c) => c.method === 'POST' && c.url.endsWith('/entries'))?.body).toEqual({
      path: 'src/util.ts',
      kind: 'file',
    }),
  )
})

test('deleting a non-empty folder asks for its typed name before recursing', async () => {
  removeNotEmpty = true
  mount()
  fireEvent.click(await screen.findByRole('treeitem', { name: /src/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
  fireEvent.click(screen.getByRole('button', { name: 'Confirm delete' }))
  const confirm = (await screen.findByRole('button', {
    name: 'Delete everything',
  })) as HTMLButtonElement
  expect(confirm.disabled).toBe(true)
  fireEvent.change(screen.getByLabelText('Type the folder name to confirm'), {
    target: { value: 'src' },
  })
  expect(confirm.disabled).toBe(false)
  fireEvent.click(confirm)
  await screen.findByText('Deleted.')
  const deletes = calls.filter((c) => c.method === 'DELETE').map((c) => c.url)
  expect(deletes[0]).toContain('path=src')
  expect(deletes[0]).not.toContain('recursive')
  expect(deletes[1]).toContain('recursive=1')
})

test('upload posts the raw file as application/octet-stream into the current folder', async () => {
  mount()
  await screen.findByRole('treeitem', { name: /README\.md/ })
  const input = screen.getByLabelText('Upload files') as HTMLInputElement
  const file = new File([new Uint8Array([1, 2, 3])], 'photo.jpg', { type: 'image/jpeg' })
  fireEvent.change(input, { target: { files: [file] } })
  await screen.findByText('Uploaded photo.jpg.')
  const post = calls.find((c) => c.url.includes('/upload'))!
  expect(post.url).toContain('path=photo.jpg')
  expect(post.headers.get('content-type')).toBe('application/octet-stream')
  expect(post.body).toBe(file)
})
