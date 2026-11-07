import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
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

const { editorView, emit, openEditor, puts, type } = createKnowledgeHarness({
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
