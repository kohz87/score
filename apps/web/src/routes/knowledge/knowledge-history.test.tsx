import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
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

test('the "Save to history again" banner survives a reload while the note is still not in history', async () => {
  const view = await openEditor()
  historyUpdated = false
  type(view, 'more')
  await screen.findByTestId('history-missed', {}, { timeout: 3000 })
  cleanup()
  mount('/knowledge/projects/Plan.md')
  await screen.findByLabelText('Contents of projects/Plan.md')
  expect(await screen.findByTestId('history-missed')).toBeTruthy()
  historyUpdated = true
  const writes = puts().length
  fireEvent.click(screen.getByRole('button', { name: 'Save to history again' }))
  await waitFor(() => expect(screen.queryByTestId('history-missed')).toBeNull(), { timeout: 3000 })
  expect(puts().length).toBe(writes + 1)
  cleanup()
  mount('/knowledge/projects/Plan.md')
  await screen.findByLabelText('Contents of projects/Plan.md')
  expect(screen.queryByTestId('history-missed')).toBeNull()
})
