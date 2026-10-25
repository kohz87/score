import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, test, vi } from 'vitest'
import { AgentDetailSchema } from '@score/contract'
import { createQueryClient } from '../../data/query-client.ts'
import { Fold, MoreCard, useFoldedList } from './MoreCard.tsx'
import { NeverCard } from './NeverCard.tsx'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function stubHeight(height: number) {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private cb: () => void) {}
      observe() {
        this.cb()
      }
      disconnect() {}
    },
  )
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get: () => height,
  })
}

test('free text taller than the limit folds, is inert while folded, and expands', () => {
  stubHeight(900)
  render(
    <MoreCard title="Long">
      <Fold foldKey="t1">
        <p>Very long text</p>
      </Fold>
    </MoreCard>,
  )
  const button = screen.getByRole('button', { name: 'Show all' })
  expect(button.getAttribute('aria-expanded')).toBe('false')
  const region = document.getElementById(button.getAttribute('aria-controls') ?? '')
  expect(region?.hasAttribute('inert')).toBe(true)
  fireEvent.click(button)
  expect(screen.getByRole('button', { name: 'Show less' }).getAttribute('aria-expanded')).toBe(
    'true',
  )
  expect(region?.hasAttribute('inert')).toBe(false)
})

test('free text that fits is not folded', () => {
  stubHeight(100)
  render(
    <Fold foldKey="t2">
      <p>Short</p>
    </Fold>,
  )
  expect(screen.queryByRole('button')).toBeNull()
})

function List({ n }: { n: number }) {
  const list = useFoldedList(
    'l',
    Array.from({ length: n }, (_, i) => `item ${i + 1}`),
  )
  return (
    <div>
      <ul id={list.id}>
        {list.shown.map((x) => (
          <li key={x}>{x}</li>
        ))}
      </ul>
      {list.toggle}
    </div>
  )
}

test('a long list shows the first 6, then Show all N and Show less', () => {
  render(<List n={9} />)
  expect(screen.getAllByRole('listitem')).toHaveLength(6)
  fireEvent.click(screen.getByRole('button', { name: 'Show all 9' }))
  expect(screen.getAllByRole('listitem')).toHaveLength(9)
  fireEvent.click(screen.getByRole('button', { name: 'Show less' }))
  expect(screen.getAllByRole('listitem')).toHaveLength(6)
})

test('a short list has no fold button', () => {
  render(<List n={6} />)
  expect(screen.queryByRole('button')).toBeNull()
})

test('Never rules fold their list but keep the add field and button visible', () => {
  const agent = AgentDetailSchema.parse({
    id: 'folder',
    name: 'folder',
    role: 'r',
    style: { color: '#19C39A', shape: 'triangle' },
    status: 'idle',
    activity: null,
    model: null,
    served: true,
    tagline: '',
    personality: { excerpt: '', source: 'SOUL.md' },
    reportsTo: null,
    worksIn: null,
    rulesFile: null,
    skills: [],
    memory: [],
    tools: [],
    helpersMax: null,
    routines: [],
    channels: [],
    permissions: Array.from({ length: 9 }, (_, i) => ({
      id: `never:cmd${i}`,
      label: `cmd${i}`,
      level: 'never',
      inherited: false,
    })),
  })
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter>
        <NeverCard agent={agent} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  const card = screen.getByRole('region', { name: /Never rules/ })
  expect(within(card).queryByText('cmd8')).toBeNull()
  expect(within(card).getByLabelText('Never allow commands that match')).toBeDefined()
  expect(within(card).getByRole('button', { name: 'Add' })).toBeDefined()
  expect(within(card).getByText(/Guardrails, not a security boundary/)).toBeDefined()
  fireEvent.click(within(card).getByRole('button', { name: 'Show all 9' }))
  expect(within(card).getByText('cmd8')).toBeDefined()
})
