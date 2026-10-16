import { CompletionContext } from '@codemirror/autocomplete'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { AgentSummary, KnowledgeChanged, StreamEvent } from '@score/contract'
import { App, appRoutes } from '../../App.tsx'
import { createQueryClient, StreamContext } from '../../data/query-client.ts'
import { createStreamQueryRegistry } from '../../data/resync.ts'
import type { StreamClient, StreamControl } from '../../data/stream.ts'
import { wikilinkCompletion } from './MarkdownEditor.tsx'
import { orphanDrafts } from './knowledge-queries.ts'

vi.mock('../../shell/use-needs-you.ts', () => ({ useNeedsYou: vi.fn(() => false) }))

type Note = { body: string; etag: string; lastAuthor: unknown; mtime: string }
type Call = { method: string; url: string; body: unknown }
let calls: Call[]
let notes: Map<string, Note>
let history: { commit: string; at: string; author: unknown; message: string }[]
let versions: Record<string, string>
let putStatus: 200 | 412
let info: { vault: string; notes: number; gitAvailable: boolean; agentAccess: boolean }
let listeners: Set<(event: StreamEvent) => void>
let router: ReturnType<typeof createMemoryRouter>
let registry: ReturnType<typeof createStreamQueryRegistry>
let nextEtag: number
let holdPut: Promise<void> | null
let failNoteReads: boolean
let controls: Set<(control: StreamControl) => void>
let unversioned: Set<string>
let historyUpdated: boolean

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

function noteJson(path: string) {
  const n = notes.get(path)!
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
    versioned: !unversioned.has(path),
  }
}

function respond(input: string, init: RequestInit = {}): Response {
  const url = new URL(input, 'http://score.test')
  const method = (init.method ?? 'GET').toUpperCase()
  const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined
  calls.push({ method, url: url.pathname + url.search, body })
  const p = url.pathname.replace('/api/knowledge', '')
  if (p === '' && method === 'GET') return json(info)
  if (p === '/settings' && method === 'PUT') {
    info = { ...info, agentAccess: (body as { agentAccess: boolean }).agentAccess }
    return json(info)
  }
  if (p === '/tree')
    return json({
      folders: ['projects', 'empty'],
      notes: [...notes.entries()].map(([path, n]) => ({
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
    notes.set(move.to, notes.get(move.from)!)
    notes.delete(move.from)
    return json({
      path: move.to,
      updatedNotes: 3,
      skipped: move.to.includes('Skipped')
        ? [{ path: 'projects/Launch.md', reason: 'it changed while the links were being updated' }]
        : [],
    })
  }
  const m = /^\/notes\/(.+?)(\/history|\/restore|\/versions\/([0-9a-f]+))?$/.exec(p)
  if (!m) return json({ error: { code: 'not_found', message: 'no' } }, 404)
  const path = decodeURIComponent(m[1]!)
  if (m[2] === '/history') return json({ items: history })
  if (m[3]) return json({ commit: m[3], body: versions[m[3]] ?? '' })
  if (m[2] === '/restore') {
    notes.get(path)!.body = versions[(body as { commit: string }).commit]!
    notes.get(path)!.etag = 'restored'
    return json({ etag: 'restored', path })
  }
  if (method === 'GET')
    return notes.has(path)
      ? json(noteJson(path))
      : json({ error: { code: 'not_found', message: 'gone' } }, 404)
  if (method === 'PUT') {
    const write = body as { body: string; etag: string | null }
    if (putStatus === 412)
      return json(
        {
          error: { code: 'precondition_failed', message: 'changed', details: { etag: 'server-2' } },
        },
        412,
      )
    if (write.etag === null && notes.has(path))
      return json({ error: { code: 'exists', message: 'exists' } }, 409)
    nextEtag += 1
    notes.set(path, {
      body: write.body,
      etag: `e${nextEtag}`,
      lastAuthor: 'you',
      mtime: '2026-01-01T00:00:00Z',
    })
    return json({
      etag: `e${nextEtag}`,
      path,
      versioned: !unversioned.has(path),
      historyUpdated,
      history: historyUpdated ? 'committed' : 'failed',
    })
  }
  if (method === 'DELETE') {
    notes.delete(path)
    return new Response(null, { status: 204 })
  }
  return json({ error: { code: 'not_found', message: 'no' } }, 404)
}

beforeEach(() => {
  orphanDrafts.clear()
  calls = []
  nextEtag = 0
  holdPut = null
  failNoteReads = false
  controls = new Set()
  putStatus = 200
  unversioned = new Set()
  historyUpdated = true
  listeners = new Set()
  info = { vault: '/vault', notes: 3, gitAvailable: true, agentAccess: true }
  const base = { lastAuthor: 'you', mtime: '2026-01-01T00:00:00Z' }
  notes = new Map([
    ['Home.md', { ...base, body: '# Home\n\nSee [[Plan]] and [[Ghost]].', etag: 'h1' }],
    ['projects/Plan.md', { ...base, body: '# Plan\n\nGoals\n', etag: 'p1' }],
    ['projects/Idea.md', { ...base, body: '# Idea\n', etag: 'i1' }],
  ])
  history = [
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
      if (isNote && init?.method === 'PUT' && holdPut) {
        calls.push({ method: 'PUT-started', url: input, body: JSON.parse(String(init.body)) })
        await holdPut
      }
      if (isNote && (init?.method ?? 'GET') === 'GET' && failNoteReads)
        return json({ error: { code: 'internal', message: 'down' } }, 500)
      return respond(input, init)
    }),
  )
})
afterEach(() => {
  localStorage.clear()
  cleanup()
  router.dispose()
  registry.dispose()
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
    onControl: (listener: (control: StreamControl) => void) => {
      controls.add(listener)
      return () => controls.delete(listener)
    },
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
const editorView = () => EditorView.findFromDOM(document.querySelector<HTMLElement>('.cm-editor')!)!
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
const puts = () => calls.filter((c) => c.method === 'PUT' && c.url.includes('/notes/'))

test(
  'Knowledge is in the main nav after Team and opens the page',
  { timeout: 20_000 },
  async () => {
    mount()
    const nav = await screen.findByRole('navigation', { name: 'Main' })
    const names = within(nav)
      .getAllByRole('link')
      .map((link) => link.textContent)
    expect(names.indexOf('Knowledge')).toBe(names.indexOf('Team') + 1)
    // The first visit loads the lazy chunk (slow when the machine is busy).
    expect(
      await screen.findByRole('heading', { name: 'Knowledge' }, { timeout: 10_000 }),
    ).toBeDefined()
    expect(await screen.findByText(/3 notes in/)).toBeDefined()
  },
)

test('the folder tree is an ARIA tree with keyboard navigation and recent notes', async () => {
  mount()
  const tree = await screen.findByRole('tree', { name: 'Notes' })
  const items = within(tree).getAllByRole('treeitem')
  expect(items.map((item) => item.getAttribute('data-kn-path'))).toEqual([
    'empty',
    'projects',
    'projects/Idea.md',
    'projects/Plan.md',
    'Home.md',
  ])
  expect(screen.getByRole('heading', { name: 'Recent' })).toBeDefined()
  items[1]!.focus()
  fireEvent.keyDown(items[1]!, { key: 'ArrowLeft' })
  expect(within(tree).queryByRole('treeitem', { name: /Plan/ })).toBeNull()
  fireEvent.keyDown(items[1]!, { key: 'ArrowRight' })
  const plan = within(tree).getByRole('treeitem', { name: /Plan/ })
  fireEvent.keyDown(plan, { key: 'Enter' })
  expect(await screen.findByLabelText('Contents of projects/Plan.md')).toBeDefined()
  expect(router.state.location.pathname).toBe('/knowledge/projects/Plan.md')
  expect(screen.getByRole('treeitem', { name: /Plan/ }).getAttribute('aria-selected')).toBe('true')
})

test('typing autosaves one second later with the etag, and the status says so', async () => {
  const view = await openEditor()
  expect(view.state.doc.toString()).toBe('# Plan\n\nGoals\n')
  expect(screen.getByRole('region', { name: 'Editor' })).toBeDefined()
  type(view, 'More')
  expect(await screen.findByText('Unsaved changes')).toBeDefined()
  expect(puts()).toHaveLength(0)
  await waitFor(() => expect(puts()).toHaveLength(1), { timeout: 3000 })
  expect(puts()[0]!.body).toEqual({ body: '# Plan\n\nGoals\nMore', etag: 'p1' })
  expect(await screen.findByText('Saved')).toBeDefined()
  // The next save uses the etag the server returned.
  type(view, '!')
  await waitFor(() => expect(puts()).toHaveLength(2), { timeout: 3000 })
  expect((puts()[1]!.body as { etag: string }).etag).toBe('e1')
})

test('a 412 shows the conflict banner: Compare diffs, Overwrite re-sends with the current etag', async () => {
  const view = await openEditor()
  putStatus = 412
  type(view, 'mine')
  const banner = await screen.findByTestId('conflict', {}, { timeout: 3000 })
  expect(within(banner).getByText(/changed somewhere else/)).toBeDefined()
  notes.get('projects/Plan.md')!.body = '# Plan\n\nTheirs\n'
  fireEvent.click(within(banner).getByRole('button', { name: 'Compare' }))
  const diff = await within(banner).findByLabelText('Differences')
  expect(diff.textContent).toContain('Theirs')
  expect(diff.textContent).toContain('mine')
  putStatus = 200
  fireEvent.click(within(banner).getByRole('button', { name: 'Overwrite' }))
  await waitFor(() => expect(screen.queryByTestId('conflict')).toBeNull())
  const last = puts().at(-1)!
  expect(last.body).toEqual({ body: '# Plan\n\nGoals\nmine', etag: 'server-2' })
})

test('Reload in the conflict banner drops my edits and loads the server text', async () => {
  const view = await openEditor()
  putStatus = 412
  type(view, 'mine')
  const banner = await screen.findByTestId('conflict', {}, { timeout: 3000 })
  notes.get('projects/Plan.md')!.body = '# Plan\n\nTheirs\n'
  fireEvent.click(within(banner).getByRole('button', { name: 'Reload' }))
  await waitFor(() => expect(editorView().state.doc.toString()).toBe('# Plan\n\nTheirs\n'))
  expect(screen.queryByTestId('conflict')).toBeNull()
})

test('[[ completion offers titles and paths from the tree', () => {
  const summaries = [
    { path: 'projects/Plan.md', title: 'Plan', mtime: '', lastAuthor: null },
    { path: 'a/Plan.md', title: 'Plan', mtime: '', lastAuthor: null },
    { path: 'Home.md', title: 'Home page', mtime: '', lastAuthor: null },
  ]
  const run = (text: string) => {
    const state = EditorState.create({ doc: text })
    return wikilinkCompletion(() => summaries)(new CompletionContext(state, text.length, false))
  }
  const hits = run('see [[pla') as { from: number; options: { label: string; apply: string }[] }
  expect(hits.from).toBe(6)
  expect(hits.options.map((o) => o.apply)).toEqual(['projects/Plan]]', 'a/Plan]]'])
  const byTitle = run('[[home') as { options: { apply: string }[] }
  expect(byTitle.options.map((o) => o.apply)).toEqual(['Home]]'])
  expect(run('no link here')).toBeNull()
  expect(run('[[done]] and more')).toBeNull()
})

test('the editor shows the note formatted; a missing link offers Create in the side panel', async () => {
  mount('/knowledge/Home.md')
  await screen.findByLabelText('Contents of Home.md')
  const dom = document.querySelector<HTMLElement>('.cm-editor')!
  expect(dom.querySelector('.cm-lp-h1')?.textContent).toContain('Home')
  const found = dom.querySelector('.cm-lp-wikilink[data-wikilink="Plan"]')!
  expect(found.classList.contains('is-missing')).toBe(false)
  expect(dom.querySelector('.cm-lp-wikilink[data-wikilink="Ghost"]')?.classList).toContain(
    'is-missing',
  )
  const side = screen.getByRole('complementary', { name: 'Note details' })
  fireEvent.click(await within(side).findByRole('button', { name: /Create/ }))
  const dialog = screen.getByRole('dialog', { name: 'New note' })
  expect((within(dialog).getByLabelText('Path in Knowledge') as HTMLInputElement).value).toBe(
    'Ghost',
  )
  fireEvent.click(within(dialog).getByRole('button', { name: 'Create note' }))
  await waitFor(() => expect(router.state.location.pathname).toBe('/knowledge/Ghost.md'))
  expect(puts()[0]!.body).toMatchObject({ etag: null })
})

test('side panels: backlinks, links with a missing note, properties', async () => {
  await openEditor()
  const side = await screen.findByRole('complementary', { name: 'Note details' })
  expect(within(side).getByRole('link', { name: 'Home' }).getAttribute('href')).toBe(
    '/knowledge/Home.md',
  )
  expect(within(side).getByRole('link', { name: 'Plan' })).toBeDefined()
  expect(within(side).getAllByText('Ghost').length).toBeGreaterThan(0)
  expect(within(side).getByText('missing')).toBeDefined()
  expect(within(side).getByText('status')).toBeDefined()
  expect(within(side).getByText('draft')).toBeDefined()
})

test('history: view a version, diff it against the current text, and restore it', async () => {
  await openEditor()
  const section = await screen.findByRole('heading', { name: 'History' })
  const panel = section.parentElement!
  fireEvent.click(await within(panel).findByRole('button', { name: 'Create Plan' }))
  const region = await within(panel).findByRole('region', { name: 'Version bbbbbbb' })
  expect(await within(region).findByText(/Old goals/)).toBeDefined()
  // The version opens in the same editor, read-only.
  expect(region.querySelector('.cm-content')?.getAttribute('contenteditable')).toBe('false')
  fireEvent.click(within(region).getByRole('button', { name: 'Compare with current' }))
  const diff = within(region).getByLabelText('Differences')
  expect(diff.textContent).toContain('Old goals')
  fireEvent.click(within(region).getByRole('button', { name: 'Restore this version' }))
  await waitFor(() => expect(editorView().state.doc.toString()).toBe('# Plan\n\nOld goals\n'))
  const restore = calls.find((c) => c.url.endsWith('/restore'))!
  expect(restore.body).toEqual({ commit: 'bbbbbbb' })
})

test('Ctrl+K focuses search, results highlight the match and open the note', async () => {
  mount()
  await screen.findByRole('tree', { name: 'Notes' })
  const search = screen.getByRole('searchbox', { name: 'Search notes' })
  fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true })
  expect(document.activeElement).toBe(search)
  expect(screen.queryByRole('dialog', { name: 'Search or run a command' })).toBeNull()
  fireEvent.change(search, { target: { value: 'launch' } })
  const results = await screen.findByRole('region', { name: 'Search results' })
  const link = await within(results).findByRole('link', { name: /Plan/ })
  expect(within(link).getByText('launch').tagName).toBe('MARK')
  expect(calls.some((c) => c.url === '/api/knowledge/search?q=launch&limit=20')).toBe(true)
  fireEvent.click(link)
  expect(await screen.findByLabelText('Contents of projects/Plan.md')).toBeDefined()
  // From the search box, the same key reaches the command palette.
  search.focus()
  fireEvent.keyDown(search, { key: 'k', ctrlKey: true })
  expect(screen.getByRole('dialog', { name: 'Search or run a command' })).toBeDefined()
})

test('Ctrl+N asks for a path, creates the note with etag null and opens it', async () => {
  mount()
  await screen.findByRole('tree', { name: 'Notes' })
  fireEvent.keyDown(document.body, { key: 'n', ctrlKey: true })
  const dialog = screen.getByRole('dialog', { name: 'New note' })
  fireEvent.change(within(dialog).getByLabelText('Path in Knowledge'), {
    target: { value: 'ideas/launch plan' },
  })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Create note' }))
  await waitFor(() =>
    expect(router.state.location.pathname).toBe('/knowledge/ideas/launch%20plan.md'),
  )
  expect(puts()[0]!.url).toBe('/api/knowledge/notes/ideas/launch%20plan.md')
  expect(puts()[0]!.body).toEqual({ body: '# launch plan\n\n', etag: null })
})

test('creating over an existing note shows the error', async () => {
  mount()
  await screen.findByRole('tree', { name: 'Notes' })
  fireEvent.keyDown(document.body, { key: 'n', ctrlKey: true })
  const dialog = screen.getByRole('dialog', { name: 'New note' })
  fireEvent.change(within(dialog).getByLabelText('Path in Knowledge'), {
    target: { value: 'Home' },
  })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Create note' }))
  expect(await within(dialog).findByRole('alert')).toBeDefined()
  expect(within(dialog).getByRole('alert').textContent).toContain('already exists')
})

test('a move says which notes still link to the old name', async () => {
  await openEditor()
  fireEvent.click(screen.getByRole('button', { name: 'Rename or move' }))
  const dialog = screen.getByRole('dialog', { name: /Rename or move/ })
  fireEvent.change(within(dialog).getByLabelText('New path'), {
    target: { value: 'archive/Skipped' },
  })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Move' }))
  expect(
    await screen.findByText(
      /Couldn’t update the links in projects\/Launch\.md\. They still link to the old name\./,
      undefined,
      { timeout: 5000 },
    ),
  ).toBeDefined()
})

test('rename with update links shows the count; delete asks first', async () => {
  await openEditor()
  fireEvent.click(screen.getByRole('button', { name: 'Rename or move' }))
  const dialog = screen.getByRole('dialog', { name: /Rename or move/ })
  fireEvent.change(within(dialog).getByLabelText('New path'), {
    target: { value: 'archive/Plan' },
  })
  expect(
    (within(dialog).getByLabelText('Update links in other notes') as HTMLInputElement).checked,
  ).toBe(true)
  fireEvent.click(within(dialog).getByRole('button', { name: 'Move' }))
  // Several async hops (move, navigate, reload, delete); generous waits so a loaded machine doesn't fail it.
  expect(
    await screen.findByText(/Updated links in 3 notes/, undefined, { timeout: 5000 }),
  ).toBeDefined()
  expect(calls.find((c) => c.url === '/api/knowledge/move')!.body).toEqual({
    from: 'projects/Plan.md',
    to: 'archive/Plan.md',
    updateLinks: true,
  })
  await waitFor(() => expect(router.state.location.pathname).toBe('/knowledge/archive/Plan.md'), {
    timeout: 5000,
  })

  // The moved note loads again under its new path: click Delete on that page, not on the one being replaced.
  await screen.findByLabelText('Contents of archive/Plan.md', undefined, { timeout: 5000 })
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
  const confirm = await screen.findByRole('dialog', { name: 'Delete Plan?' }, { timeout: 5000 })
  expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
  fireEvent.click(within(confirm).getByRole('button', { name: 'Delete note' }))
  await waitFor(() => expect(router.state.location.pathname).toBe('/knowledge'), { timeout: 5000 })
  expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('archive/Plan.md'))).toBe(true)
}, 15_000)

test('a change by an agent to the open note shows a banner instead of overwriting the editor', async () => {
  const view = await openEditor()
  notes.get('projects/Plan.md')!.body = '# Plan\n\nAgent text\n'
  notes.get('projects/Plan.md')!.etag = 'p2'
  emit({ path: 'projects/Plan.md', kind: 'written', to: null, by: { agentId: 'builder' } })
  const banner = await screen.findByText(/Changed by/)
  expect(banner.textContent).toContain('Builder')
  expect(editorView().state.doc.toString()).toBe('# Plan\n\nGoals\n')
  expect(editorView()).toBe(view)
  fireEvent.click(within(banner).getByRole('button', { name: 'Reload' }))
  await waitFor(() => expect(editorView().state.doc.toString()).toBe('# Plan\n\nAgent text\n'))
  expect(screen.queryByText(/Changed by/)).toBeNull()
})

test('a change by you updates the tree but shows no banner; other notes never show one', async () => {
  await openEditor()
  const treeCalls = () => calls.filter((c) => c.url === '/api/knowledge/tree').length
  const before = treeCalls()
  emit({ path: 'projects/Plan.md', kind: 'written', to: null, by: 'you' })
  emit({ path: 'Home.md', kind: 'written', to: null, by: { agentId: 'builder' } })
  await waitFor(() => expect(treeCalls()).toBeGreaterThan(before))
  expect(screen.queryByText(/Changed by/)).toBeNull()
})

test('agent-written notes are marked, and Undo restores the commit before the agent’s', async () => {
  notes.get('projects/Plan.md')!.lastAuthor = { agentId: 'builder' }
  notes.get('projects/Plan.md')!.mtime = new Date(Date.now() - 2 * 60_000).toISOString()
  history = [
    { commit: 'aaaaaaa', at: '', author: { agentId: 'builder' }, message: 'builder: edit' },
    { commit: 'bbbbbbb', at: '', author: 'you', message: 'Create Plan' },
  ]
  await openEditor()
  const mark = await screen.findByTestId('agent-edit')
  expect(mark.textContent).toContain('Edited by')
  expect(mark.textContent).toContain('Builder')
  expect(mark.textContent).toContain('2 min ago')
  expect(mark.querySelector('.agent-glyph')).not.toBeNull()
  fireEvent.click(await within(mark).findByRole('button', { name: 'Undo this change' }))
  await waitFor(() =>
    expect(calls.find((c) => c.url.endsWith('/restore'))!.body).toEqual({ commit: 'bbbbbbb' }),
  )
  await waitFor(() => expect(editorView().state.doc.toString()).toBe('# Plan\n\nOld goals\n'))
})

test('a missing note at a deep link offers to create it', async () => {
  mount('/knowledge/nope/Missing.md')
  expect(await screen.findByText('This note doesn’t exist')).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: /Create nope\/Missing\.md/ }))
  const dialog = screen.getByRole('dialog', { name: 'New note' })
  expect((within(dialog).getByLabelText('Path in Knowledge') as HTMLInputElement).value).toBe(
    'nope/Missing',
  )
})

test('Settings › Knowledge shows the vault, git status and the agent switch', async () => {
  mount('/settings')
  const section = await screen.findByRole('region', { name: 'Knowledge' })
  expect(await within(section).findByText('/vault')).toBeDefined()
  expect(within(section).getByText(/Versioned with git/)).toBeDefined()
  const toggle = within(section).getByRole('switch', { name: 'Agents can use Knowledge' })
  expect((toggle as HTMLInputElement).checked).toBe(true)
  fireEvent.click(toggle)
  await waitFor(() => expect((toggle as HTMLInputElement).checked).toBe(false))
  const put = calls.find((c) => c.url === '/api/knowledge/settings')!
  expect(put).toMatchObject({ method: 'PUT', body: { agentAccess: false } })
})

// Audit wave 4 (batch B): the draft is never replaced by anything the person did not ask for.
test('Source keeps the text and the caret, and typing continues in either view', async () => {
  const view = await openEditor()
  type(view, ' one')
  await waitFor(() => expect(puts()).toHaveLength(1), { timeout: 3000 })
  await screen.findByText('Saved')
  act(() => view.dispatch({ selection: { anchor: 3 } }))
  const source = screen.getByRole('button', { name: 'Source' })
  expect(source.getAttribute('aria-pressed')).toBe('false')
  fireEvent.click(source)
  expect(source.getAttribute('aria-pressed')).toBe('true')
  // The same editor, reconfigured: not a new one.
  expect(editorView()).toBe(view)
  expect(document.querySelector('.cm-editor.cm-source')).not.toBeNull()
  expect(view.state.doc.toString()).toBe('# Plan\n\nGoals\n one')
  expect(view.state.selection.main.head).toBe(3)
  type(view, ' two')
  fireEvent.click(source)
  expect(document.querySelector('.cm-editor.cm-source')).toBeNull()
  expect(editorView().state.doc.toString()).toBe('# Plan\n\nGoals\n one two')
  await waitFor(() => expect(puts()).toHaveLength(2), { timeout: 3000 })
  expect(puts()[1]!.body).toMatchObject({ body: '# Plan\n\nGoals\n one two' })
})

test('leaving the note during a save still saves what was typed meanwhile', async () => {
  let release: () => void = () => undefined
  holdPut = new Promise<void>((resolve) => {
    release = resolve
  })
  const view = await openEditor()
  type(view, ' first')
  await waitFor(() => expect(calls.some((c) => c.method === 'PUT-started')).toBe(true), {
    timeout: 3000,
  })
  type(view, ' second')
  act(() => {
    void router.navigate('/knowledge/Home.md')
  })
  await screen.findByLabelText('Contents of Home.md')
  holdPut = null
  release()
  await waitFor(() => expect(puts()).toHaveLength(2), { timeout: 3000 })
  expect(puts()[1]!.body).toMatchObject({ body: '# Plan\n\nGoals\n first second', etag: 'e1' })
})

test('renaming a note with unsaved text saves the text first', async () => {
  const view = await openEditor()
  type(view, ' draft')
  fireEvent.click(screen.getByRole('button', { name: 'Rename or move' }))
  const dialog = screen.getByRole('dialog', { name: /Rename or move/ })
  fireEvent.change(within(dialog).getByLabelText('New path'), { target: { value: 'archive/Plan' } })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Move' }))
  await waitFor(() => expect(router.state.location.pathname).toBe('/knowledge/archive/Plan.md'))
  const order = calls
    .filter((c) => c.method === 'PUT' || c.url.endsWith('/move'))
    .map((c) => c.method)
  expect(order.slice(0, 2)).toEqual(['PUT', 'POST'])
  expect(puts()[0]!.body).toMatchObject({ body: '# Plan\n\nGoals\n draft' })
  expect(notes.get('archive/Plan.md')!.body).toBe('# Plan\n\nGoals\n draft')
})

test('a failed background read keeps the editor and the unsaved text', async () => {
  const view = await openEditor()
  putStatus = 412
  type(view, ' mine')
  await screen.findByTestId('conflict', {}, { timeout: 3000 })
  failNoteReads = true
  emit({ path: 'projects/Plan.md', kind: 'written', to: null, by: { agentId: 'builder' } })
  await waitFor(() => expect(screen.getAllByRole('alert').length).toBeGreaterThan(1))
  expect(screen.queryByText('Couldn’t open this note')).toBeNull()
  expect(editorView().state.doc.toString()).toBe('# Plan\n\nGoals\n mine')
})

test('a Markdown link with a malformed #wiki: target does not crash the editor', async () => {
  notes.get('Home.md')!.body = 'Bad [broken](#wiki:%E0%A4%A) link'
  mount('/knowledge/Home.md')
  await screen.findByLabelText('Contents of Home.md')
  expect(editorView().state.doc.toString()).toContain('broken')
})

test('a save from another browser (author you) offers Reload; our own save does not', async () => {
  const view = await openEditor()
  type(view, ' mine')
  await waitFor(() => expect(puts()).toHaveLength(1), { timeout: 3000 })
  await screen.findByText('Saved')
  emit({ path: 'projects/Plan.md', kind: 'written', to: null, by: 'you' })
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(screen.queryByTestId('changed-elsewhere')).toBeNull()
  notes.get('projects/Plan.md')!.body = '# Plan\n\nFrom my phone\n'
  notes.get('projects/Plan.md')!.etag = 'phone'
  emit({ path: 'projects/Plan.md', kind: 'written', to: null, by: 'you' })
  const banner = await screen.findByTestId('changed-elsewhere')
  expect(editorView().state.doc.toString()).toBe('# Plan\n\nGoals\n mine')
  fireEvent.click(within(banner).getByRole('button', { name: 'Reload' }))
  await waitFor(() => expect(editorView().state.doc.toString()).toBe('# Plan\n\nFrom my phone\n'))
  expect(screen.queryByTestId('changed-elsewhere')).toBeNull()
})

test('after a stream resync the open note offers Reload when it changed meanwhile', async () => {
  await openEditor()
  notes.get('projects/Plan.md')!.body = '# Plan\n\nMissed change\n'
  notes.get('projects/Plan.md')!.etag = 'missed'
  act(() => controls.forEach((listener) => listener({ resync: true } as StreamControl)))
  await screen.findByTestId('changed-elsewhere')
  expect(editorView().state.doc.toString()).toBe('# Plan\n\nGoals\n')
})

test('wikilinks follow notes created elsewhere', async () => {
  mount('/knowledge/Home.md')
  await screen.findByLabelText('Contents of Home.md')
  const ghost = () => document.querySelector('.cm-lp-wikilink[data-wikilink="Ghost"]')
  expect(ghost()?.classList).toContain('is-missing')
  notes.set('Ghost.md', {
    body: '# Ghost\n',
    etag: 'g1',
    lastAuthor: 'you',
    mtime: '2026-01-01T00:00:00Z',
  })
  emit({ path: 'Ghost.md', kind: 'written', to: null, by: { agentId: 'builder' } })
  await waitFor(() => expect(ghost()?.classList.contains('is-missing')).toBe(false))
})

test('text that could not be saved before leaving comes back when the note is opened again', async () => {
  const view = await openEditor()
  putStatus = 412
  type(view, ' unsaved')
  await screen.findByTestId('conflict', {}, { timeout: 3000 })
  act(() => {
    void router.navigate('/knowledge/Home.md')
  })
  await screen.findByLabelText('Contents of Home.md')
  act(() => {
    void router.navigate('/knowledge/projects/Plan.md')
  })
  await screen.findByLabelText('Contents of projects/Plan.md')
  expect(editorView().state.doc.toString()).toBe('# Plan\n\nGoals\n unsaved')
  expect(await screen.findByTestId('conflict', {}, { timeout: 3000 })).toBeDefined()
})

// PLAN 6.8: one editor, no Preview; Source is remembered per device.
test('a note opens in the live editor with a toolbar and no Preview / Edit / Split switch', async () => {
  mount('/knowledge/projects/Plan.md')
  expect(await screen.findByLabelText('Contents of projects/Plan.md')).toBeDefined()
  expect(screen.getByRole('toolbar', { name: 'Formatting' })).toBeDefined()
  for (const name of ['Preview', 'Edit', 'Split'])
    expect(screen.queryByRole('button', { name })).toBeNull()
  expect(document.querySelector('.cm-lp-h1')).not.toBeNull()
})

test('Source is remembered on this device', async () => {
  mount('/knowledge/projects/Plan.md')
  fireEvent.click(await screen.findByRole('button', { name: 'Source' }))
  expect(localStorage.getItem('score.knowledge.source')).toBe('1')
  cleanup()
  router.dispose()
  registry.dispose()
  mount('/knowledge/projects/Plan.md')
  await screen.findByLabelText('Contents of projects/Plan.md')
  expect(screen.getByRole('button', { name: 'Source' }).getAttribute('aria-pressed')).toBe('true')
  expect(document.querySelector('.cm-editor.cm-source')).not.toBeNull()
})

test('a blocked localStorage does not break the Source switch', async () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('blocked')
  })
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('blocked')
  })
  mount('/knowledge/projects/Plan.md')
  fireEvent.click(await screen.findByRole('button', { name: 'Source' }))
  expect(document.querySelector('.cm-editor.cm-source')).not.toBeNull()
  vi.restoreAllMocks()
})

test('a note with an embedded image shows the picture, never the data, and saves it unchanged', async () => {
  const data =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  const image = `![chart](data:image/png;base64,${data})`
  notes.get('projects/Plan.md')!.body = `# Plan\n\n${image}\n`
  const view = await openEditor()
  const dom = document.querySelector<HTMLElement>('.cm-editor')!
  expect(dom.querySelector('.cm-lp-image img')).not.toBeNull()
  expect(dom.textContent).not.toContain('base64')
  type(view, 'More')
  await waitFor(() => expect(puts()).toHaveLength(1), { timeout: 3000 })
  expect(puts()[0]!.body).toEqual({ body: `# Plan\n\n${image}\nMore`, etag: 'p1' })
  // Source collapses it to a chip.
  fireEvent.click(screen.getByRole('button', { name: 'Source' }))
  expect(dom.querySelector('.cm-lp-image-chip')?.textContent).toBe('data:image/png · 70 B')
  expect(dom.textContent).not.toContain('base64')
})

test('a note outside history shows the badge, the reason, and warns before overwrite and delete', async () => {
  unversioned = new Set(['projects/Plan.md'])
  const view = await openEditor()
  expect((await screen.findByTestId('not-in-history')).textContent).toBe('Not kept in history')
  expect(
    screen.getByText(/\.gitignore excludes this folder, so Score saves the note/),
  ).toBeDefined()
  expect((await screen.findByTestId('history-not-kept')).textContent).toMatch(
    /\.gitignore excludes this folder/,
  )
  expect(screen.queryByText(/No saved versions yet/)).toBeNull()

  putStatus = 412
  type(view, 'mine')
  const banner = await screen.findByTestId('conflict', {}, { timeout: 3000 })
  expect(within(banner).getByText(/there is no earlier version/)).toBeDefined()
  putStatus = 200
  fireEvent.click(within(banner).getByRole('button', { name: 'Overwrite' }))
  await waitFor(() => expect(screen.queryByTestId('conflict')).toBeNull())

  fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
  const confirm = await screen.findByRole('dialog', { name: 'Delete Plan?' })
  await within(confirm).findByText(/no earlier version to restore/)
})

test('a normal note shows no history warning; a failed history update is reported after a save', async () => {
  const view = await openEditor()
  expect(screen.queryByTestId('not-in-history')).toBeNull()
  expect(screen.queryByTestId('history-missed')).toBeNull()
  historyUpdated = false
  type(view, 'more')
  expect((await screen.findByTestId('history-missed', {}, { timeout: 3000 })).textContent).toMatch(
    /Saved, but history wasn’t updated/,
  )
  historyUpdated = true
  type(view, ' again')
  await waitFor(() => expect(screen.queryByTestId('history-missed')).toBeNull(), { timeout: 3000 })
})

test('after a failed history update, "Save to history again" retries without any text change', async () => {
  const view = await openEditor()
  historyUpdated = false
  type(view, 'more')
  await screen.findByTestId('history-missed', {}, { timeout: 3000 })
  const writes = () => calls.filter((call) => call.method === 'PUT').length
  const before = writes()
  historyUpdated = true
  fireEvent.click(screen.getByRole('button', { name: 'Save to history again' }))
  await waitFor(() => expect(screen.queryByTestId('history-missed')).toBeNull(), { timeout: 3000 })
  expect(writes()).toBe(before + 1)
  expect(screen.queryByRole('button', { name: 'Save to history again' })).toBeNull()
})
