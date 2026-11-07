import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import type { StreamControl } from '../../data/stream.ts'
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

const { editorView, emit, mount, openEditor, puts, type } = createKnowledgeHarness({
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

test('a change by you updates the tree but shows no banner; other notes never show one', async () => {
  await openEditor()
  const treeCalls = () => calls.filter((c) => c.url === '/api/knowledge/tree').length
  const before = treeCalls()
  emit({ path: 'projects/Plan.md', kind: 'written', to: null, by: 'you' })
  emit({ path: 'Home.md', kind: 'written', to: null, by: { agentId: 'builder' } })
  await waitFor(() => expect(treeCalls()).toBeGreaterThan(before))
  expect(screen.queryByText(/Changed by/)).toBeNull()
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
