import { EditorView } from '@codemirror/view'
import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, vi } from 'vitest'
import { createQueryClient } from '../../data/query-client.ts'
import { WorkspaceTab } from './WorkspaceTab.tsx'

type Call = { method: string; url: string; body: unknown; headers: Headers }
type WorkspaceInfo = { root: string | null; available: boolean; reason: string | null }
type DirectoryEntries = Map<string, { name: string; kind: 'file' | 'dir' }[]>
type GitStatus = { branch: string; changed: number; ahead: number; behind: number } | null
type WorkspaceState = {
  calls: Call[]
  info: WorkspaceInfo
  files: Map<string, string>
  dirs: DirectoryEntries
  etag: string
  saveStatus: 200 | 412
  removeNotEmpty: boolean
  failFileReads: boolean
  gitStatus: GitStatus
  client: ReturnType<typeof createQueryClient> | undefined
}

function initialState(): WorkspaceState {
  return {
    calls: [],
    info: { root: '/work/project', available: true, reason: null },
    files: new Map([
      ['README.md', 'hello'],
      ['src/main.ts', 'export {}'],
    ]),
    dirs: new Map([
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
    ]),
    etag: 'etag-1',
    saveStatus: 200,
    removeNotEmpty: false,
    failFileReads: false,
    gitStatus: null,
    client: undefined,
  }
}

export const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function handle(input: string, init: RequestInit = {}, state: WorkspaceState): Response {
  const url = new URL(input, 'http://score.test')
  const method = (init.method ?? 'GET').toUpperCase()
  const path = url.searchParams.get('path') ?? ''
  const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body
  state.calls.push({
    method,
    url: url.pathname + url.search,
    body,
    headers: new Headers(init.headers),
  })
  const tail = url.pathname.replace('/api/agents/builder/workspace', '')
  if (tail === '' && method === 'GET') return json(200, state.info)
  if (tail === '/root' && method === 'PUT') {
    state.info = { root: body.path, available: true, reason: null }
    return json(200, state.info)
  }
  if (tail === '/git') return json(200, state.gitStatus)
  if (tail === '/tree')
    return json(200, {
      entries: (state.dirs.get(path) ?? []).map((entry) => ({
        ...entry,
        size: 1,
        mtime: '2026-01-01T00:00:00.000Z',
        hidden: entry.name.startsWith('.'),
      })),
    })
  if (tail === '/file' && method === 'GET') {
    if (state.failFileReads) return json(500, { error: { code: 'internal', message: 'down' } })
    if (path.endsWith('.bin')) return json(200, { binary: true, size: 2048, reason: 'binary' })
    return new Response(state.files.get(path) ?? '', {
      headers: { 'content-type': 'text/plain; charset=utf-8', etag: `"${state.etag}"` },
    })
  }
  if (tail === '/file' && method === 'PUT') {
    if (state.saveStatus === 412)
      return json(412, {
        error: { code: 'precondition_failed', message: 'changed', details: { etag: 'disk2' } },
      })
    state.files.set(path, body.content)
    state.etag = 'new-etag'
    return json(200, { etag: state.etag })
  }
  if (tail === '/entries' && method === 'POST') return json(201, {})
  if (tail === '/entries' && method === 'DELETE') {
    if (state.removeNotEmpty && url.searchParams.get('recursive') !== '1')
      return json(409, { error: { code: 'not_empty', message: 'The folder is not empty' } })
    return json(200, {})
  }
  if (tail === '/upload') return json(201, { path, size: 3 })
  return json(404, { error: { code: 'not_found', message: 'no' } })
}

export function createWorkspaceTabHarness() {
  let state = initialState()
  beforeEach(() => {
    state = initialState()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => handle(input, init, state)),
    )
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })
  return {
    get calls() {
      return state.calls
    },
    get info() {
      return state.info
    },
    set info(value: WorkspaceInfo) {
      state.info = value
    },
    get files() {
      return state.files
    },
    get dirs() {
      return state.dirs
    },
    get etag() {
      return state.etag
    },
    set etag(value: string) {
      state.etag = value
    },
    get saveStatus() {
      return state.saveStatus
    },
    set saveStatus(value: 200 | 412) {
      state.saveStatus = value
    },
    get removeNotEmpty() {
      return state.removeNotEmpty
    },
    set removeNotEmpty(value: boolean) {
      state.removeNotEmpty = value
    },
    get failFileReads() {
      return state.failFileReads
    },
    set failFileReads(value: boolean) {
      state.failFileReads = value
    },
    get gitStatus() {
      return state.gitStatus
    },
    set gitStatus(value: GitStatus) {
      state.gitStatus = value
    },
    get client() {
      return state.client!
    },
    handler(input: string, init: RequestInit = {}) {
      return handle(input, init, state)
    },
    mount(initialPath: string | null = null) {
      state.client = createQueryClient()
      return render(
        <QueryClientProvider client={state.client}>
          <WorkspaceTab agentId="builder" agentName="Builder" initialPath={initialPath} />
        </QueryClientProvider>,
      )
    },
    treeCalls() {
      return state.calls
        .filter((call) => call.url.includes('/workspace/tree'))
        .map((call) => call.url)
    },
  }
}

const view = () => EditorView.findFromDOM(document.querySelector<HTMLElement>('.cm-editor')!)!
export function setText(text: string) {
  const editor = view()
  act(() => {
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: text } })
  })
}
export { view }
