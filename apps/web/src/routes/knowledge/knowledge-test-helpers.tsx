import { EditorView } from '@codemirror/view'
import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen } from '@testing-library/react'
import { createMemoryRouter } from 'react-router'
import { afterEach, beforeEach, vi } from 'vitest'
import type { AgentSummary, KnowledgeChanged, StreamEvent } from '@score/contract'
import { App, appRoutes } from '../../App.tsx'
import { createQueryClient, StreamContext } from '../../data/query-client.ts'
import { createStreamQueryRegistry } from '../../data/resync.ts'
import type { StreamClient, StreamControl } from '../../data/stream.ts'
import { orphanDrafts } from './knowledge-queries.ts'

export type KnowledgeNote = { body: string; etag: string; lastAuthor: unknown; mtime: string }
export type KnowledgeCall = { method: string; url: string; body: unknown }
export type KnowledgeHistoryEntry = { commit: string; at: string; author: unknown; message: string }
export type KnowledgeControl = (control: StreamControl) => void
export type KnowledgeRouter = ReturnType<typeof createMemoryRouter>
export type KnowledgeRegistry = ReturnType<typeof createStreamQueryRegistry>

type KnowledgeInfo = {
  vault: string
  notes: number
  gitAvailable: boolean
  agentAccess: boolean
  memoryNotes: boolean
}

type KnowledgeBindings = {
  calls: KnowledgeCall[]
  notes: Map<string, KnowledgeNote>
  history: KnowledgeHistoryEntry[]
  putStatus: 200 | 412
  router: KnowledgeRouter
  registry: KnowledgeRegistry
  holdPut: Promise<void> | null
  failNoteReads: boolean
  controls: Set<KnowledgeControl>
  unversioned: Set<string>
  historyUpdated: boolean
}

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
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const titleOf = (path: string) => (path.split('/').pop() ?? '').replace(/\.md$/, '')

export function createKnowledgeHarness(bindings: KnowledgeBindings) {
  let info: KnowledgeInfo
  let listeners: Set<(event: StreamEvent) => void>
  let versions: Record<string, string>
  let nextEtag: number
  // The server's view after the last save: its commit did not land, so a later read says `failed`.
  let historyPending: boolean

  function noteJson(path: string) {
    const n = bindings.notes.get(path)!
    return {
      path,
      title: titleOf(path),
      frontmatter: { status: 'draft' },
      body: n.body,
      etag: n.etag,
      mtime: n.mtime,
      links: [
        { target: 'Plan', path: 'projects/Plan.md' },
        { target: 'Ghost', path: null },
      ],
      backlinks: [{ path: 'Home.md', title: 'Home' }],
      lastAuthor: n.lastAuthor,
      versioned: !bindings.unversioned.has(path),
      history: historyPending ? 'failed' : 'unchanged',
    }
  }

  function respond(input: string, init: RequestInit = {}): Response {
    const url = new URL(input, 'http://score.test')
    const method = (init.method ?? 'GET').toUpperCase()
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined
    bindings.calls.push({ method, url: url.pathname + url.search, body })
    const p = url.pathname.replace('/api/knowledge', '')
    if (p === '' && method === 'GET') return json(info)
    if (p === '/settings' && method === 'PUT') {
      info = { ...info, ...(body as { agentAccess?: boolean; memoryNotes?: boolean }) }
      return json(info)
    }
    if (p === '/tree')
      return json({
        folders: ['projects', 'empty'],
        notes: [...bindings.notes.entries()].map(([path, n]) => ({
          path,
          title: titleOf(path),
          mtime: n.mtime,
          lastAuthor: n.lastAuthor,
        })),
      })
    if (p === '/search')
      return json({
        items: [{ path: 'projects/Plan.md', title: 'Plan', snippet: 'the [[launch]] plan' }],
      })
    if (p === '/move' && method === 'POST') {
      const move = body as { from: string; to: string }
      bindings.notes.set(move.to, bindings.notes.get(move.from)!)
      bindings.notes.delete(move.from)
      return json({
        path: move.to,
        updatedNotes: 3,
        skipped: move.to.includes('Skipped')
          ? [
              {
                path: 'projects/Launch.md',
                reason: 'it changed while the links were being updated',
              },
            ]
          : [],
      })
    }
    const m = /^\/notes\/(.+?)(\/history|\/restore|\/versions\/([0-9a-f]+))?$/.exec(p)
    if (!m) return json({ error: { code: 'not_found', message: 'no' } }, 404)
    const path = decodeURIComponent(m[1]!)
    if (m[2] === '/history') return json({ items: bindings.history })
    if (m[3]) return json({ commit: m[3], body: versions[m[3]] ?? '' })
    if (m[2] === '/restore') {
      bindings.notes.get(path)!.body = versions[(body as { commit: string }).commit]!
      bindings.notes.get(path)!.etag = 'restored'
      return json({ etag: 'restored', path })
    }
    if (method === 'GET')
      return bindings.notes.has(path)
        ? json(noteJson(path))
        : json({ error: { code: 'not_found', message: 'gone' } }, 404)
    if (method === 'PUT') {
      const write = body as { body: string; etag: string | null }
      if (bindings.putStatus === 412)
        return json(
          {
            error: {
              code: 'precondition_failed',
              message: 'changed',
              details: { etag: 'server-2' },
            },
          },
          412,
        )
      if (write.etag === null && bindings.notes.has(path))
        return json({ error: { code: 'exists', message: 'exists' } }, 409)
      nextEtag += 1
      historyPending = !bindings.historyUpdated
      bindings.notes.set(path, {
        body: write.body,
        etag: `e${nextEtag}`,
        lastAuthor: 'you',
        mtime: '2026-01-01T00:00:00Z',
      })
      return json({
        etag: `e${nextEtag}`,
        path,
        versioned: !bindings.unversioned.has(path),
        historyUpdated: bindings.historyUpdated,
        history: bindings.historyUpdated ? 'committed' : 'failed',
      })
    }
    if (method === 'DELETE') {
      bindings.notes.delete(path)
      return new Response(null, { status: 204 })
    }
    return json({ error: { code: 'not_found', message: 'no' } }, 404)
  }

  beforeEach(() => {
    orphanDrafts.clear()
    bindings.calls = []
    nextEtag = 0
    bindings.holdPut = null
    bindings.failNoteReads = false
    bindings.controls = new Set()
    bindings.putStatus = 200
    bindings.unversioned = new Set()
    bindings.historyUpdated = true
    historyPending = false
    listeners = new Set()
    info = { vault: '/vault', notes: 3, gitAvailable: true, agentAccess: true, memoryNotes: true }
    const base = { lastAuthor: 'you', mtime: '2026-01-01T00:00:00Z' }
    bindings.notes = new Map([
      ['Home.md', { ...base, body: '# Home\n\nSee [[Plan]] and [[Ghost]].', etag: 'h1' }],
      ['projects/Plan.md', { ...base, body: '# Plan\n\nGoals\n', etag: 'p1' }],
      ['projects/Idea.md', { ...base, body: '# Idea\n', etag: 'i1' }],
    ])
    bindings.history = [
      { commit: 'aaaaaaa', at: '2026-01-01T00:05:00Z', author: 'you', message: 'Edit Plan' },
      { commit: 'bbbbbbb', at: '2026-01-01T00:01:00Z', author: 'you', message: 'Create Plan' },
    ]
    versions = { aaaaaaa: '# Plan\n\nGoals\n', bbbbbbb: '# Plan\n\nOld goals\n' }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        if (input === '/api/agents') return json({ asOfSeq: 0, items: [builder] })
        const isNote =
          input.startsWith('/api/knowledge/notes/') && !/\/(history|restore|versions)/.test(input)
        if (isNote && init?.method === 'PUT' && bindings.holdPut) {
          bindings.calls.push({
            method: 'PUT-started',
            url: input,
            body: JSON.parse(String(init.body)),
          })
          await bindings.holdPut
        }
        if (isNote && (init?.method ?? 'GET') === 'GET' && bindings.failNoteReads)
          return json({ error: { code: 'internal', message: 'down' } }, 500)
        return respond(input, init)
      }),
    )
  })
  afterEach(() => {
    localStorage.clear()
    cleanup()
    bindings.router?.dispose()
    bindings.registry?.dispose()
    vi.unstubAllGlobals()
  })

  function mount(url = '/knowledge') {
    const queryClient = createQueryClient()
    queryClient.setDefaultOptions({ queries: { retry: false } })
    const stream = {
      subscribe: (listener: (event: StreamEvent) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      onControl: (listener: KnowledgeControl) => {
        bindings.controls.add(listener)
        return () => bindings.controls.delete(listener)
      },
    }
    bindings.registry = createStreamQueryRegistry(queryClient, stream)
    bindings.router = createMemoryRouter(appRoutes, { initialEntries: [url] })
    render(
      <QueryClientProvider client={queryClient}>
        <StreamContext
          value={{ client: stream as unknown as StreamClient, queries: bindings.registry }}
        >
          <App router={bindings.router} />
        </StreamContext>
      </QueryClientProvider>,
    )
  }
  function emit(data: KnowledgeChanged) {
    act(() => {
      listeners.forEach((listener) =>
        listener({
          seq: 1,
          ts: '2026-01-01T00:00:00Z',
          type: 'knowledge.changed',
          data,
        } as StreamEvent),
      )
    })
  }
  const editorView = () =>
    EditorView.findFromDOM(document.querySelector<HTMLElement>('.cm-editor')!)!
  async function openEditor(url = '/knowledge/projects/Plan.md') {
    mount(url)
    await screen.findByLabelText('Contents of projects/Plan.md')
    return editorView()
  }
  function type(view: EditorView, text: string) {
    act(() => {
      view.dispatch({ changes: { from: view.state.doc.length, insert: text } })
    })
  }
  const puts = () => bindings.calls.filter((c) => c.method === 'PUT' && c.url.includes('/notes/'))

  return { emit, editorView, mount, openEditor, puts, type }
}
