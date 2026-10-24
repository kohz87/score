import type { AgentSummary, Job, NowSnapshot } from '@score/contract'
import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createQueryClient } from '../data/query-client.ts'
import { nowKey } from '../routes/now/now-queries.ts'
import { BoldSearch } from './BoldSearch.tsx'

const agents: AgentSummary[] = [
  {
    id: 'lead',
    name: 'lead',
    role: 'Leads the team',
    style: { color: '#6B4EFF', shape: 'circle-dot' },
    status: 'idle',
    activity: null,
    model: { id: 'fake-model', label: 'Demo model' },
    served: true,
  },
  {
    id: 'builder',
    name: 'builder',
    role: 'Builds features',
    style: { color: '#19C39A', shape: 'triangle' },
    status: 'working',
    activity: null,
    model: { id: 'fake-model', label: 'Demo model' },
    served: true,
  },
]

const job = (id: string, title: string): Job => ({
  id,
  roomId: 'team',
  title,
  state: 'working',
  holderAgentId: 'builder',
  isDefault: false,
  exchangeBudget: 8,
  jobTurnLimit: 40,
  unread: 0,
  activeAgents: [],
  lastMessageAt: null,
  messageCount: 0,
  summary: null,
  createdAt: '2026-10-24T10:00:00.000Z',
  updatedAt: '2026-10-24T10:00:00.000Z',
})

const teamRoom = {
  id: 'team-room',
  name: 'Team room',
  kind: 'room',
  leadAgentId: null,
  members: ['lead', 'builder'],
  unread: 0,
  activeAgents: [],
  channels: [],
  role: 'team',
  routing: 'exchanges',
} as const

function respond(body: unknown, status = 200) {
  return Promise.resolve(
    Response.json(body, { status, headers: { 'content-type': 'application/json' } }),
  )
}

const nowSnapshot = (paused = false): NowSnapshot => ({
  asOfSeq: 1,
  now: '2026-10-24T10:00:00.000Z',
  paused,
  headline: { working: 0, needsYou: 0, text: 'The team is quiet.' },
  lanes: [],
  handoffs: [],
  focusApproval: null,
  thread: null,
  madeToday: [],
})

function installFetch(overrides: Record<string, unknown | Promise<Response>> = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://x')
      const body = overrides[url.pathname]
      if (body instanceof Promise) return body
      if (body instanceof Response) return Promise.resolve(body)
      if (body !== undefined) return respond(body)
      if (url.pathname === '/api/team-room')
        return respond({
          asOfSeq: 1,
          room: teamRoom,
          jobs: [job('job_alpha', 'Release alpha'), job('job_beta', 'Release beta')],
        })
      if (url.pathname.startsWith('/api/agents/') && url.pathname.endsWith('/direct'))
        return respond({ asOfSeq: 1, room: null, chats: [] })
      if (url.pathname === '/api/knowledge/tree')
        return respond({ folders: [], notes: [], documents: [] })
      if (url.pathname === '/api/knowledge/search') return respond({ items: [] })
      if (url.pathname === '/api/search/messages') return respond({ items: [] })
      if (url.pathname === '/api/commands')
        return respond({
          items: [
            {
              name: 'assign',
              usage: '/assign @agent <title>',
              description: 'Create a task.',
            },
          ],
        })
      return respond({ asOfSeq: 0, items: [] })
    }),
  )
}

function open({ now }: { now?: NowSnapshot } = {}) {
  const queryClient = createQueryClient()
  if (now !== undefined) queryClient.setQueryData(nowKey, now)
  const onClose = vi.fn()
  const router = createMemoryRouter(
    [
      {
        path: '*',
        element: (
          <BoldSearch
            agents={agents}
            light={false}
            onClose={onClose}
            onToggleLook={() => undefined}
            onResetLook={() => undefined}
          />
        ),
      },
    ],
    { initialEntries: ['/b'] },
  )
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return { router, onClose, queryClient }
}

beforeEach(() => installFetch())

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

test('focus starts in the box and arrow keys move the selection before Enter opens it', async () => {
  const { router, onClose } = open()
  const input = screen.getByRole('combobox', { name: 'Search or run a command' })
  await waitFor(() => expect(document.activeElement).toBe(input))
  fireEvent.change(input, { target: { value: 'release' } })

  const options = await screen.findAllByRole('option')
  expect(options).toHaveLength(2)
  await waitFor(() => expect(options[0]?.getAttribute('aria-selected')).toBe('true'))
  fireEvent.keyDown(input, { key: 'ArrowDown' })
  expect(options[1]?.getAttribute('aria-selected')).toBe('true')
  fireEvent.keyDown(input, { key: 'ArrowUp' })
  expect(options[0]?.getAttribute('aria-selected')).toBe('true')
  fireEvent.keyDown(input, { key: 'Enter' })
  await waitFor(() => expect(router.state.location.search).toBe('?job=job_alpha'))
  expect(onClose).toHaveBeenCalledOnce()
})

test('Escape closes the dialog and Tab is trapped between the box and Close', async () => {
  const { onClose } = open()
  const dialog = screen.getByRole('dialog', { name: 'Search and commands' })
  const input = screen.getByRole('combobox', { name: 'Search or run a command' })
  await waitFor(() => expect(document.activeElement).toBe(input))
  const close = screen.getByRole('button', { name: 'Close search' })

  close.focus()
  fireEvent.keyDown(close, { key: 'Tab' })
  expect(document.activeElement).toBe(input)
  fireEvent.keyDown(input, { key: 'Tab', shiftKey: true })
  expect(document.activeElement).toBe(close)

  fireEvent.keyDown(dialog, { key: 'Escape' })
  expect(onClose).toHaveBeenCalledOnce()
})

test('Enter and arrows during IME composition leave the results alone', async () => {
  const { router, onClose } = open()
  const input = screen.getByRole('combobox', { name: 'Search or run a command' })
  fireEvent.change(input, { target: { value: 'release' } })
  const options = await screen.findAllByRole('option')
  await waitFor(() => expect(options[0]?.getAttribute('aria-selected')).toBe('true'))

  fireEvent.keyDown(input, { key: 'ArrowDown', isComposing: true })
  expect(options[0]?.getAttribute('aria-selected')).toBe('true')
  fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
  expect(router.state.location.search).toBe('')
  expect(onClose).not.toHaveBeenCalled()
})

test('a second Pause everyone activation while pending sends one request', async () => {
  let finishPause!: (response: Response) => void
  const pauseResponse = new Promise<Response>((resolve) => {
    finishPause = resolve
  })
  installFetch({ '/api/now': nowSnapshot(), '/api/team/pause': pauseResponse })
  const { onClose } = open()
  const input = screen.getByRole('combobox', { name: 'Search or run a command' })
  fireEvent.change(input, { target: { value: 'Pause everyone' } })
  const pause = await screen.findByRole('option', { name: 'Pause everyone' })
  expect((pause as HTMLButtonElement).disabled).toBe(false)

  fireEvent.keyDown(input, { key: 'Enter' })
  fireEvent.keyDown(input, { key: 'Enter' })
  await waitFor(() =>
    expect(
      vi.mocked(fetch).mock.calls.filter(([input]) => String(input).endsWith('/api/team/pause')),
    ).toHaveLength(1),
  )

  finishPause(Response.json({ paused: true, affectedRuns: 0 }))
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
})

test('a failed pause read disables Pause everyone and explains why', async () => {
  installFetch({
    '/api/now': Promise.resolve(
      Response.json({ error: { code: 'request_failed', message: 'No snapshot' } }, { status: 500 }),
    ),
  })
  open()
  const input = screen.getByRole('combobox', { name: 'Search or run a command' })
  fireEvent.change(input, { target: { value: 'Pause everyone' } })
  const pause = await screen.findByRole('option', { name: 'Pause everyone' })
  await waitFor(() => expect((pause as HTMLButtonElement).disabled).toBe(true))
  expect(screen.getByText("Couldn't read whether the team is paused")).toBeDefined()
})

test('a Now snapshot already in the cache is used without fetching pause state again', async () => {
  open({ now: nowSnapshot(true) })
  await screen.findByRole('option', { name: 'Resume everyone' })
  expect(
    vi.mocked(fetch).mock.calls.filter(([input]) => String(input).endsWith('/api/now')),
  ).toHaveLength(0)
})

test('one-to-one chats are fetched once while the query keeps changing', async () => {
  open()
  const directCalls = () =>
    vi.mocked(fetch).mock.calls.filter(([input]) => String(input).endsWith('/direct'))
  await waitFor(() => expect(directCalls()).toHaveLength(2))

  const input = screen.getByRole('combobox', { name: 'Search or run a command' })
  fireEvent.change(input, { target: { value: 're' } })
  fireEvent.change(input, { target: { value: 'release' } })
  await waitFor(() =>
    expect(
      vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes('/api/search/messages')),
    ).toBe(true),
  )
  expect(directCalls()).toHaveLength(2)
})

test('a query with no hits shows the prototype empty line', async () => {
  open()
  const input = screen.getByRole('combobox', { name: 'Search or run a command' })
  fireEvent.change(input, { target: { value: 'zzzz' } })
  expect(await screen.findByText('Nothing matches.')).toBeDefined()
  expect(screen.queryAllByRole('option')).toHaveLength(0)
})
