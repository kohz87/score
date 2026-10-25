import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, test, vi } from 'vitest'
import { AgentDetailSchema } from '@score/contract'
import { createQueryClient } from '../../data/query-client.ts'
import { useFoldedList } from './MoreCard.tsx'
import { NeverCard } from './NeverCard.tsx'
import { GoAheadCard } from './GoAheadCard.tsx'
import { CanUseCard } from './CanUseCard.tsx'
import { PluginsCard } from './PluginsCard.tsx'
import { ChannelsCard } from './ChannelsCard.tsx'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
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

function makeAgent(extra: object) {
  return AgentDetailSchema.parse({
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
    permissions: [],
    ...extra,
  })
}

const many = <T,>(n: number, make: (i: number) => T) => Array.from({ length: n }, (_, i) => make(i))

test('every folded card: the toggle controls an element that holds the list', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const path = new URL(String(input), 'http://x').pathname
      if (path.endsWith('/settings/plugins'))
        return Promise.resolve(
          Response.json({
            items: many(9, (i) => ({
              id: `p${i}`,
              label: `Plugin ${i}`,
              enabled: false,
              locked: false,
              description: null,
            })),
          }),
        )
      if (path.endsWith('/channels'))
        return Promise.resolve(
          Response.json({
            items: many(9, (i) => ({
              platform: `ch${i}`,
              label: `Channel ${i}`,
              status: 'disconnected',
              detail: null,
              connectCommand: 'x',
            })),
          }),
        )
      return Promise.resolve(Response.json({ enabled: false }))
    }),
  )
  const cards = [
    <GoAheadCard
      key="g"
      agent={makeAgent({
        permissions: many(9, (i) => ({
          id: `allowed:c${i}`,
          label: `c${i}`,
          level: 'allowed',
          inherited: false,
        })),
      })}
    />,
    <CanUseCard
      key="c"
      coding={false}
      agent={makeAgent({
        tools: many(10, (i) => ({
          id: `t${i}`,
          label: `Tool ${i}`,
          kind: 'builtin',
          enabled: true,
        })),
      })}
    />,
    <PluginsCard key="p" agent={makeAgent({})} />,
    <ChannelsCard key="h" agent={makeAgent({})} />,
    <NeverCard
      key="n"
      agent={makeAgent({
        permissions: many(9, (i) => ({
          id: `never:c${i}`,
          label: `c${i}`,
          level: 'never',
          inherited: false,
        })),
      })}
    />,
  ]
  for (const card of cards) {
    render(
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter>{card}</MemoryRouter>
      </QueryClientProvider>,
    )
    const toggle = await screen.findByRole('button', { name: /^Show all \d+/ })
    const target = document.getElementById(toggle.getAttribute('aria-controls') ?? '')
    expect(target).not.toBeNull()
    expect(target?.children.length).toBeGreaterThan(0)
    cleanup()
  }
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
