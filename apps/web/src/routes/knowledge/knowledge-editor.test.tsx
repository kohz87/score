import { CompletionContext } from '@codemirror/autocomplete'
import { EditorState } from '@codemirror/state'
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { wikilinkCompletion } from './MarkdownEditor.tsx'
import {
  createKnowledgeHarness,
  type KnowledgeCall,
  type KnowledgeControl,
  type KnowledgeHistoryEntry,
  type KnowledgeNote,
  type KnowledgeRegistry,
  type KnowledgeRouter,
} from './knowledge-test-helpers.tsx'

vi.mock('../../shell/use-needs-you.ts', () => ({ useNeedsYou: vi.fn(() => false) }))

let calls: KnowledgeCall[]
let notes: Map<string, KnowledgeNote>
let history: KnowledgeHistoryEntry[]
let putStatus: 200 | 412
let router: KnowledgeRouter
let registry: KnowledgeRegistry
let holdPut: Promise<void> | null
let failNoteReads: boolean
let controls: Set<KnowledgeControl>
let unversioned: Set<string>
let historyUpdated: boolean

const { editorView, mount, openEditor, puts, type } = createKnowledgeHarness({
  get calls() {
    return calls
  },
  set calls(value) {
    calls = value
  },
  get notes() {
    return notes
  },
  set notes(value) {
    notes = value
  },
  get history() {
    return history
  },
  set history(value) {
    history = value
  },
  get putStatus() {
    return putStatus
  },
  set putStatus(value) {
    putStatus = value
  },
  get router() {
    return router
  },
  set router(value) {
    router = value
  },
  get registry() {
    return registry
  },
  set registry(value) {
    registry = value
  },
  get holdPut() {
    return holdPut
  },
  set holdPut(value) {
    holdPut = value
  },
  get failNoteReads() {
    return failNoteReads
  },
  set failNoteReads(value) {
    failNoteReads = value
  },
  get controls() {
    return controls
  },
  set controls(value) {
    controls = value
  },
  get unversioned() {
    return unversioned
  },
  set unversioned(value) {
    unversioned = value
  },
  get historyUpdated() {
    return historyUpdated
  },
  set historyUpdated(value) {
    historyUpdated = value
  },
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

test('a Markdown link with a malformed #wiki: target does not crash the editor', async () => {
  notes.get('Home.md')!.body = 'Bad [broken](#wiki:%E0%A4%A) link'
  mount('/knowledge/Home.md')
  await screen.findByLabelText('Contents of Home.md')
  expect(editorView().state.doc.toString()).toContain('broken')
})

// PLAN 6.8: one editor, no Preview; Source is remembered per device.
test('a note opens in the live editor with a toolbar and no Preview / Edit / Split switch', async () => {
  mount('/knowledge/projects/Plan.md')
  expect(await screen.findByLabelText('Contents of projects/Plan.md')).toBeDefined()
  expect(screen.getByRole('toolbar', { name: 'Formatting' })).toBeDefined()
  for (const name of ['Preview', 'Split']) expect(screen.queryByRole('button', { name })).toBeNull()
  // The page's Edit only moves focus into the editor; it is not a mode switch.
  expect(screen.getByRole('button', { name: 'Edit' }).hasAttribute('aria-pressed')).toBe(false)
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
