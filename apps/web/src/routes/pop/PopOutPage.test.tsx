import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { flowFixture } from '../../../../../e2e/flow-fixture.ts'
import { createQueryClient, StreamContext } from '../../data/query-client.ts'
import { createStreamClient } from '../../data/stream.ts'
import { createStreamQueryRegistry } from '../../data/resync.ts'
import { appRoutes } from '../../App.tsx'
import { openPopOut, popOutPath, popOutWindowName } from './pop-out.ts'

vi.mock('../../shell/use-needs-you.ts', () => ({ useNeedsYou: vi.fn(() => false) }))

class Source extends EventTarget {
  close() {}
}
let fixture: ReturnType<typeof flowFixture>
let requests: string[]
let directs: unknown[]
const dispose: (() => void)[] = []
const response = (data: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(data), { status }))
const direct = {
  id: 'dm-builder',
  name: 'builder',
  kind: 'direct',
  leadAgentId: 'builder',
  members: ['builder'],
  unread: 0,
  activeAgents: [],
  channels: [],
}

beforeEach(() => {
  localStorage.clear()
  fixture = flowFixture('room-flow')
  requests = []
  directs = [direct]
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      requests.push(`${init?.method ?? 'GET'} ${url}`)
      if (url === '/api/agents') return response({ asOfSeq: 1, items: fixture.agents })
      if (url === '/api/now') return response(fixture.score)
      if (url === '/api/rooms') return response({ asOfSeq: 1, rooms: [], directs, projects: [] })
      if (url === '/api/commands') return response({ items: [] })
      if (url.startsWith('/api/briefs?'))
        return response({ items: url.endsWith('active') ? [fixture.flow.brief] : [] })
      if (url.endsWith('/flow')) return response(fixture.flow)
      if (url.includes('/stop')) return response({ ok: true })
      if (url.startsWith('/api/flow/nodes/')) return response(fixture.detail)
      return response({ error: { code: 'not_found', message: 'Missing fixture' } }, 404)
    }),
  )
})
afterEach(() => {
  cleanup()
  dispose.splice(0).forEach((fn) => fn())
  vi.unstubAllGlobals()
})

function mount(agentId: string) {
  const queryClient = createQueryClient()
  const client = createStreamClient({ EventSourceImpl: Source })
  const queries = createStreamQueryRegistry(queryClient, client)
  const router = createMemoryRouter(appRoutes, { initialEntries: [`/agents/${agentId}/pop`] })
  dispose.push(() => {
    router.dispose()
    queries.dispose()
    client.close()
    queryClient.clear()
  })
  render(
    <QueryClientProvider client={queryClient}>
      <StreamContext value={{ client, queries }}>
        <RouterProvider router={router} />
      </StreamContext>
    </QueryClientProvider>,
  )
}

test(
  'the pop-out shows the lane, the current step, a message box and Stop, without the app shell',
  { timeout: 15000 },
  async () => {
    mount('builder')
    const page = await screen.findByRole('main', { name: 'builder, live view' })
    expect(screen.queryByRole('navigation')).toBeNull()
    expect(await within(page).findByRole('region', { name: 'Now' })).toBeTruthy()
    expect(await within(page).findByRole('group', { name: /builder/ })).toBeTruthy()
    expect(await within(page).findByRole('complementary', { name: 'Selected step' })).toBeTruthy()
    expect(
      await within(page).findByRole('combobox', { name: 'Message builder' }, { timeout: 5000 }),
    ).toBeTruthy()
    // Stop lives in the header, once: the inspector's own "Stop this step" is hidden.
    expect(within(page).queryByRole('button', { name: 'Stop this step' })).toBeNull()
    const stop = await within(page).findByRole('button', { name: 'Stop' })
    await waitFor(() => expect((stop as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(stop)
    await waitFor(() =>
      expect(
        requests.some((r) => r.startsWith('POST /api/flow/nodes/') && r.endsWith('/stop')),
      ).toBe(true),
    )
  },
)

test('an agent with no run says so and the message box still works', async () => {
  mount('lead')
  expect(await screen.findByText(/lead is not in a run right now/)).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
})

test('an agent without a direct conversation points to Chat', async () => {
  directs = []
  mount('builder')
  expect(await screen.findByText(/No direct conversation with builder yet/)).toBeTruthy()
})

test('an unknown agent is a plain message, not a crash', async () => {
  mount('nobody')
  expect(await screen.findByText(/There is no agent called nobody/)).toBeTruthy()
})

test('the window is named per agent so a second click focuses it', () => {
  const focus = vi.fn()
  const open = vi.fn() as ReturnType<typeof vi.fn<(...args: unknown[]) => { focus: () => void }>>
  open.mockReturnValue({ focus })
  vi.stubGlobal('open', open)
  openPopOut('builder')
  openPopOut('builder')
  openPopOut('re viewer/1')
  expect(open).toHaveBeenNthCalledWith(
    1,
    '/agents/builder/pop',
    'score-agent-builder',
    expect.stringContaining('popup'),
  )
  expect(open.mock.calls[1]![1]).toBe(open.mock.calls[0]![1])
  expect(popOutWindowName('re viewer/1')).toBe('score-agent-re_viewer_1')
  expect(popOutPath('a b')).toBe('/agents/a%20b/pop')
  expect(focus).toHaveBeenCalledTimes(3)
})
