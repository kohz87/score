import { fireEvent, screen, within } from '@testing-library/react'
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

const { mount, openEditor } = createKnowledgeHarness({
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

test('a missing note at a deep link offers to create it', async () => {
  mount('/knowledge/nope/Missing.md')
  expect(await screen.findByText('This note doesn’t exist')).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: /Create nope\/Missing\.md/ }))
  const dialog = screen.getByRole('dialog', { name: 'New note' })
  expect((within(dialog).getByLabelText('Path in Knowledge') as HTMLInputElement).value).toBe(
    'nope/Missing',
  )
})
