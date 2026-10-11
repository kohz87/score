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
let failFileReads = false
let gitStatus: { branch: string; changed: number; ahead: number; behind: number } | null

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
  if (tail === '/git') return json(200, gitStatus)
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
    if (failFileReads) return json(500, { error: { code: 'internal', message: 'down' } })
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
  failFileReads = false
  gitStatus = null
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => handler(input, init)),
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

let client: ReturnType<typeof createQueryClient>
function mount(initialPath: string | null = null) {
  client = createQueryClient()
  return render(
    <QueryClientProvider client={client}>
      <WorkspaceTab agentId="builder" agentName="Builder" initialPath={initialPath} />
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
  expect(treeCalls()).toEqual(['/api/agents/builder/workspace/tree?path=&root=%2Fwork%2Fproject'])
  fireEvent.click(screen.getByRole('treeitem', { name: /src/ }))
  await screen.findByRole('treeitem', { name: /main\.ts/ })
  expect(treeCalls()).toContain(
    '/api/agents/builder/workspace/tree?path=src&root=%2Fwork%2Fproject',
  )
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

test(
  'a CSV file has a table Preview (at most 1000 rows); HTML stays source',
  { timeout: 20_000 },
  async () => {
    files.set('data.csv', 'name,qty\nbolt,4\n')
    files.set('page.html', '<h1>x</h1>')
    dirs.get('')!.push({ name: 'data.csv', kind: 'file' }, { name: 'page.html', kind: 'file' })
    mount()
    fireEvent.click(await screen.findByRole('treeitem', { name: /data\.csv/ }))
    await screen.findByLabelText('Contents of data.csv', {}, { timeout: 10_000 })
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    const preview = screen.getByLabelText('Preview of data.csv')
    expect(within(preview).getByRole('cell', { name: 'bolt' })).toBeTruthy()
    fireEvent.click(screen.getByRole('treeitem', { name: /page\.html/ }))
    await screen.findByLabelText('Contents of page.html')
    expect(screen.queryByRole('button', { name: 'Preview' })).toBeNull()
    expect(document.querySelector('.ws h1')).toBeNull()
  },
)

test('the header shows the git branch and changed count only inside a repository', async () => {
  mount()
  await screen.findByRole('tree', { name: 'Files' })
  expect(screen.queryByLabelText(/Git branch/)).toBeNull()
  cleanup()
  gitStatus = { branch: 'trunk', changed: 3, ahead: 1, behind: 0 }
  mount()
  const badge = await screen.findByLabelText('Git branch trunk, 3 changed files')
  expect(badge.textContent).toContain('trunk')
  expect(badge.textContent).toContain('3 changed')
  expect(badge.textContent).toContain('↑1')
})

test(
  'a workspace:// deep link opens that file with its folders expanded; a bad path shows the error',
  { timeout: 20_000 },
  async () => {
    mount('src/main.ts')
    await screen.findByLabelText('Contents of src/main.ts', {}, { timeout: 10_000 })
    expect(view().state.doc.toString()).toBe('export {}')
    expect(screen.getByRole('treeitem', { name: /src/ }).getAttribute('aria-expanded')).toBe('true')
    cleanup()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) =>
        input.includes('/file?')
          ? json(403, { error: { code: 'blocked', message: 'That file is not available' } })
          : handler(input, init),
      ),
    )
    mount('.env')
    expect((await screen.findAllByRole('alert'))[0]!.textContent).toMatch(/not available|blocked/i)
  },
)

test('the separator resizes the file list with the keyboard and the width is remembered', async () => {
  window.localStorage.removeItem('score.workspace.treeWidth')
  mount()
  const bar = await screen.findByRole('separator', { name: 'Resize the file list' })
  expect(bar.getAttribute('aria-valuenow')).toBe('300')
  fireEvent.keyDown(bar, { key: 'ArrowRight' })
  expect(bar.getAttribute('aria-valuenow')).toBe('316')
  fireEvent.keyDown(bar, { key: 'Home' })
  expect(bar.getAttribute('aria-valuenow')).toBe('200')
  fireEvent.keyDown(bar, { key: 'ArrowLeft' })
  expect(bar.getAttribute('aria-valuenow')).toBe('200')
  fireEvent.keyDown(bar, { key: 'End' })
  expect(bar.getAttribute('aria-valuenow')).toBe('640')
  expect(window.localStorage.getItem('score.workspace.treeWidth')).toBe('640')
  cleanup()
  mount()
  expect(
    (await screen.findByRole('separator', { name: 'Resize the file list' })).getAttribute(
      'aria-valuenow',
    ),
  ).toBe('640')
  window.localStorage.removeItem('score.workspace.treeWidth')
})

test('images preview by URL and binaries offer a download', async () => {
  mount()
  fireEvent.click(await screen.findByRole('treeitem', { name: /logo\.png/ }))
  const img = (await screen.findByRole('img')) as HTMLImageElement
  expect(img.getAttribute('src')).toBe(
    '/api/agents/builder/workspace/file?path=logo.png&root=%2Fwork%2Fproject',
  )
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
    expect(calls.find((c) => c.method === 'POST' && c.url.includes('/entries'))?.body).toEqual({
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

test(
  'a failed background read keeps the editor and the unsaved text, and says so',
  { timeout: 20_000 },
  async () => {
    mount()
    fireEvent.click(await screen.findByRole('treeitem', { name: /README\.md/ }))
    await screen.findByLabelText('Contents of README.md', {}, { timeout: 10_000 })
    setText('unsaved work')
    failFileReads = true
    const reads = () => calls.filter((c) => c.method === 'GET' && c.url.includes('/file')).length
    const before = reads()
    await act(async () => {
      await client.refetchQueries({ queryKey: ['team', 'workspace', 'builder', 'file'] })
    })
    await waitFor(() => expect(reads()).toBeGreaterThan(before))
    expect((await screen.findByRole('alert')).textContent).toMatch(/Couldn’t/)
    expect(view().state.doc.toString()).toBe('unsaved work')
    // Retrying after the connection is back refreshes without replacing the draft.
    failFileReads = false
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(view().state.doc.toString()).toBe('unsaved work')
  },
)

test('every file request names the root the browser is showing', async () => {
  mount()
  fireEvent.click(await screen.findByRole('treeitem', { name: /README\.md/ }))
  await screen.findByLabelText('Contents of README.md', {}, { timeout: 10_000 })
  const fileCalls = calls.filter((c) => /\/(tree|file|git)\b/.test(c.url))
  expect(fileCalls.length).toBeGreaterThan(2)
  for (const call of fileCalls) expect(call.url, call.url).toContain('root=%2Fwork%2Fproject')
}, 20_000)

test('selecting several files uploads all of them even though the picker is cleared at once', async () => {
  mount()
  await screen.findByRole('treeitem', { name: /README\.md/ })
  const input = screen.getByLabelText('Upload files') as HTMLInputElement
  const a = new File([new Uint8Array([1])], 'a.txt')
  const b = new File([new Uint8Array([2])], 'b.txt')
  // A live FileList: clearing the input empties it.
  const list: File[] = [a, b]
  Object.defineProperty(input, 'files', { get: () => list, configurable: true })
  Object.defineProperty(input, 'value', {
    get: () => '',
    set: () => {
      list.length = 0
    },
    configurable: true,
  })
  fireEvent.change(input)
  await screen.findByText('Uploaded b.txt.')
  const uploaded = calls.filter((c) => c.url.includes('/upload')).map((c) => c.url)
  expect(uploaded).toHaveLength(2)
})

test('unsaved edits survive switching to another file and back, and are not mistaken for saved', async () => {
  mount()
  fireEvent.click(await screen.findByRole('treeitem', { name: /README\.md/ }))
  await screen.findByLabelText('Contents of README.md', {}, { timeout: 10_000 })
  setText('half-written')
  fireEvent.click(screen.getByRole('treeitem', { name: /src/ }))
  fireEvent.click(await screen.findByRole('treeitem', { name: /main\.ts/ }))
  await screen.findByLabelText('Contents of src/main.ts', {}, { timeout: 10_000 })
  fireEvent.click(screen.getByRole('treeitem', { name: /README\.md/ }))
  await screen.findByLabelText('Contents of README.md', {}, { timeout: 10_000 })
  expect(view().state.doc.toString()).toBe('half-written')
  expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(false)
  expect(calls.filter((c) => c.method === 'PUT' && c.url.includes('/file'))).toHaveLength(0)
}, 30_000)
