import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createQueryClient, StreamContext } from '../data/query-client.ts'
import { createStreamQueryRegistry } from '../data/resync.ts'
import { createStreamClient } from '../data/stream.ts'
import { BoldScreensPage } from './BoldScreens.tsx'

class Source extends EventTarget {
  close() {}
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status })
const agent = (id: string, color: string, shape: string) => ({
  id,
  name: id,
  role: '',
  style: { color, shape },
  status: 'idle',
  activity: null,
  model: null,
  served: true,
})
const agents = [
  agent('builder', '#19C39A', 'square'),
  agent('reviewer', '#FFB61E', 'triangle'),
  agent('lead', '#6B4EFF', 'hexagon'),
  agent('designer', '#F28AC0', 'diamond'),
  agent('scout', '#4FC8D1', 'circle-dot'),
]
const item = (id: string, patch: Record<string, unknown> = {}) => ({
  agent: agents.find((entry) => entry.id === id),
  thumbnail: null,
  status: `${id} is doing things`,
  live: false,
  surface: null,
  ...patch,
})

let overview: unknown[]
let overviewFails = false
let bots: Record<string, unknown>
let agentList: unknown[]
let phone = false
const disposers: (() => void)[] = []

beforeEach(() => {
  overview = []
  overviewFails = false
  bots = {}
  agentList = agents
  phone = false
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: phone && query.includes('600px'),
        media: query,
        addEventListener() {},
        removeEventListener() {},
      }) as unknown as MediaQueryList,
  )
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/agents') return Promise.resolve(json({ asOfSeq: 1, items: agentList }))
      if (url === '/api/watch/overview')
        return Promise.resolve(
          overviewFails
            ? json({ error: { code: 'internal', message: 'no' } }, 500)
            : json({ items: overview }),
        )
      const id = /^\/api\/agents\/([^/]+)\/bot-screen$/.exec(url)?.[1]
      if (id && bots[id] === 'pending') return new Promise<Response>(() => undefined)
      if (id) return Promise.resolve(json(bots[id] ?? { state: 'off' }))
      return Promise.resolve(json({ error: { code: 'not_found', message: 'none' } }, 404))
    }),
  )
})

afterEach(() => {
  cleanup()
  disposers.splice(0).forEach((dispose) => dispose())
  vi.unstubAllGlobals()
})

function mount() {
  const queryClient = createQueryClient()
  const client = createStreamClient({ EventSourceImpl: Source })
  const queries = createStreamQueryRegistry(queryClient, client)
  disposers.push(() => {
    queries.dispose()
    client.close()
    queryClient.clear()
  })
  const router = createMemoryRouter(
    [
      { path: '/b/screens', Component: BoldScreensPage },
      { path: '*', element: <p>elsewhere</p> },
    ],
    { initialEntries: ['/b/screens'] },
  )
  render(
    <QueryClientProvider client={queryClient}>
      <StreamContext value={{ client, queries }}>
        <RouterProvider router={router} />
      </StreamContext>
    </QueryClientProvider>,
  )
}

const card = (name: string) => screen.findByRole('article', { name: `${name}’s screen` })

test('a card per agent with its doing line and the Open screen link', async () => {
  overview = agents.map((entry) => item(entry.id))
  mount()
  for (const entry of agents) {
    const view = within(await card(entry.id))
    expect(view.getByText(`${entry.id} is doing things`)).toBeDefined()
    expect(view.getByRole('link', { name: 'Open screen' }).getAttribute('href')).toBe(
      `/b/screen/${entry.id}`,
    )
    expect(view.getByText('Idle')).toBeDefined()
    expect(view.getByText('Nothing on screen')).toBeDefined()
  }
})

test('a running desktop shows its frame, the Live desktop badge and Take over…', async () => {
  overview = [item('builder')]
  bots = { builder: { state: 'running', width: 1280, height: 800, frameSeq: 4 } }
  mount()
  const view = within(await card('builder'))
  const img = await view.findByAltText('builder’s desktop, live')
  expect(img.getAttribute('src')).toBe('/api/agents/builder/bot-screen/frame?seq=4')
  expect(view.getByText('Live desktop')).toBeDefined()
  expect(view.getByRole('link', { name: 'Take over…' }).getAttribute('href')).toBe(
    '/b/screen/builder?take=1',
  )
})

test('Take over… is not offered while someone holds the desktop or when it is not running', async () => {
  overview = [item('builder'), item('reviewer'), item('lead')]
  bots = {
    builder: {
      state: 'running',
      frameSeq: 1,
      control: {
        takeoverId: 't1',
        since: '2026-11-02T12:00:00.000Z',
        idleExpiresAt: '2026-11-02T12:05:00.000Z',
        expiresAt: '2026-11-02T12:30:00.000Z',
      },
    },
    reviewer: { state: 'human' },
    lead: { state: 'sandboxed' },
  }
  mount()
  for (const name of ['builder', 'reviewer', 'lead']) {
    const view = within(await card(name))
    await waitFor(() => expect(view.queryByRole('link', { name: 'Open screen' })).not.toBeNull())
    expect(view.queryByRole('link', { name: 'Take over…' })).toBeNull()
  }
})

test('a held desktop shows no picture, the red protected badge and the hidden line', async () => {
  overview = [item('reviewer', { thumbnail: '/api/media/secret' })]
  bots = { reviewer: { state: 'human' } }
  mount()
  const view = within(await card('reviewer'))
  const badge = await view.findByText('Someone has control')
  expect(badge.getAttribute('data-protected')).toBe('inline-flex')
  expect(
    view.getByText('Someone has taken over this desktop. Score hides it while they work.'),
  ).toBeDefined()
  expect(view.queryByRole('img')).toBeNull()
  expect(document.querySelector('img[src="/api/media/secret"]')).toBeNull()
})

test('without a desktop: the screenshot, else a drawing of the surface, with a Working badge', async () => {
  overview = [
    item('builder', { thumbnail: '/api/media/shot', live: true, surface: 'browser' }),
    item('reviewer', { live: true, surface: 'terminal' }),
  ]
  mount()
  const shot = within(await card('builder'))
  expect(shot.getByText('Working · browser')).toBeDefined()
  expect(document.querySelector('img[src="/api/media/shot"]')).not.toBeNull()
  const drawn = within(await card('reviewer'))
  expect(drawn.getByText('Working · terminal')).toBeDefined()
  expect(drawn.getByText('$ pnpm test')).toBeDefined()
})

test('the overview failing says so but the cards still render', async () => {
  overviewFails = true
  mount()
  expect(await screen.findByText(/can’t read what the agents are doing/)).toBeDefined()
  expect(await card('builder')).toBeDefined()
})

test('no agents shows the empty line', async () => {
  agentList = []
  mount()
  expect(await screen.findByText('No agents yet.')).toBeDefined()
})

test('on a phone each agent is one row linking to its screen', async () => {
  phone = true
  overview = [item('builder')]
  bots = { builder: { state: 'running', frameSeq: 2 } }
  mount()
  const link = await screen.findByRole('link', { name: /^builder, Live desktop/ })
  expect(link.getAttribute('href')).toBe('/b/screen/builder')
  expect(screen.queryByRole('link', { name: 'Take over…' })).toBeNull()
})

// Review (3.18.0): until a desktop's state is known, a person may be using it.
test('no picture of any kind while the desktop’s state is still unknown', async () => {
  overview = [item('builder', { thumbnail: '/api/media/shot', live: true, surface: 'browser' })]
  bots = { builder: 'pending' }
  mount()
  const unknown = within(await card('builder'))
  expect(unknown.getByText('Checking the screen…')).toBeDefined()
  expect(document.querySelector('img[src="/api/media/shot"]')).toBeNull()
})
