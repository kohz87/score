import { readFileSync } from 'node:fs'
import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  orchestrationEvents,
  orchestrationFixtures,
} from '../../../../../e2e/orchestration-fixtures.ts'
import { App, appRoutes } from '../../App.tsx'
import { createQueryClient, StreamContext } from '../../data/query-client.ts'
import { createStreamQueryRegistry, immediateFrameScheduler } from '../../data/resync.ts'
import { createStreamClient } from '../../data/stream.ts'

// PLAN 8.4 in the browser: the user view's room shows a run's progress as Score status lines between the messages,
// answers what needs the person inline, keeps Pause and Stop, and opens the admin view's Flow for the details.

class Source extends EventTarget {
  close() {}
}
// The recorded fake-mode reads the visual baselines are made from: one room, four neutral agents.
const recorded = JSON.parse(readFileSync('../../e2e/fixtures/visual.json', 'utf8')) as Record<
  string,
  unknown
>
const fixtures: Record<string, unknown> = {
  '/api/rooms': recorded['/api/rooms'],
  '/api/agents': recorded['/api/agents'],
  '/api/rooms/room-activity-feed': recorded['/api/rooms/room-activity-feed'],
  '/api/rooms/room-activity-feed/messages?limit=50':
    recorded['/api/rooms/room-activity-feed/messages?limit=50'],
  '/api/rooms/room-activity-feed/versions': { items: [] },
  '/api/commands': { items: [] },
  '/api/workflow-runs': { asOfSeq: 0, items: [] },
  ...orchestrationFixtures,
  '/api/orchestrations/orch-1/events': orchestrationEvents,
}
let posts: { url: string; body: unknown }[]
const disposers: (() => void)[] = []

beforeEach(() => {
  posts = []
  window.localStorage.clear()
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: false,
        media: query,
        addEventListener() {},
        removeEventListener() {},
      }) as unknown as MediaQueryList,
  )
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://x')
      url.searchParams.delete('tz')
      const key = `${url.pathname}${url.search}`
      if (init?.method === 'POST') {
        posts.push({ url: key, body: JSON.parse(String(init.body ?? '{}')) })
        return Promise.resolve(
          Response.json(
            fixtures['/api/orchestrations'] &&
              (fixtures['/api/orchestrations'] as { items: unknown[] }).items[0],
          ),
        )
      }
      const fixture = fixtures[key]
      return Promise.resolve(
        fixture === undefined
          ? Response.json({ error: { code: 'not_found', message: 'none' } }, { status: 404 })
          : Response.json(fixture),
      )
    }),
  )
})
afterEach(() => {
  cleanup()
  disposers.splice(0).forEach((fn) => fn())
  vi.unstubAllGlobals()
})

function open(path: string) {
  const queryClient = createQueryClient()
  const client = createStreamClient({ EventSourceImpl: Source as never })
  const queries = createStreamQueryRegistry(queryClient, client, immediateFrameScheduler)
  const router = createMemoryRouter(appRoutes, { initialEntries: [path] })
  disposers.push(() => {
    router.dispose()
    queries.dispose()
    client.close()
    queryClient.clear()
  })
  render(
    <QueryClientProvider client={queryClient}>
      <StreamContext value={{ client, queries }}>
        <App router={router} />
      </StreamContext>
    </QueryClientProvider>,
  )
  return router
}

test('a run’s room shows Score status lines, with no admin links', async () => {
  open('/u/rooms/room-activity-feed')
  const lines = await screen.findAllByText(/Step s1 \(builder\) finished\./)
  expect(lines.length).toBeGreaterThan(0)
  expect(await screen.findByText(/Waiting for you: approve s3\./)).toBeTruthy()
  // Score’s lines carry no agent glyph and no message actions.
  const line = lines[0]!.closest('[data-status-line]') as HTMLElement
  expect(line.querySelector('.agent-glyph')).toBeNull()
  expect(within(line).queryByRole('button')).toBeNull()
  expect(screen.queryByRole('link', { name: 'See it on the Score' })).toBeNull()
  expect(screen.queryByRole('link', { name: 'Open the live diagram' })).toBeNull()
})

test('what needs the person is answered in the conversation', async () => {
  open('/u/rooms/room-activity-feed')
  const gate = await screen.findByRole('region', { name: 'Approve s3' })
  fireEvent.click(within(gate).getByRole('button', { name: 'Approve s3' }))
  await waitFor(() =>
    expect(posts.some((post) => post.url === '/api/orchestrations/orch-1/gates/g3/decision')).toBe(
      true,
    ),
  )
  expect(posts.find((post) => post.url.endsWith('/decision'))!.body).toMatchObject({
    decision: 'approve',
    expectedRevision: 1,
    orchestrationRevision: 9,
  })
})

test('Pause is one click and Stop asks first', async () => {
  open('/u/rooms/room-activity-feed')
  const run = await screen.findByRole('region', { name: 'Orchestration' })
  fireEvent.click(await within(run).findByRole('button', { name: 'Pause' }))
  await waitFor(() =>
    expect(posts.some((post) => post.url === '/api/orchestrations/orch-1/pause')).toBe(true),
  )
  fireEvent.click(within(run).getByRole('button', { name: 'Stop' }))
  expect(posts.some((post) => post.url.endsWith('/stop'))).toBe(false)
  fireEvent.click(within(run).getByRole('button', { name: 'Stop the run' }))
  await waitFor(() =>
    expect(posts.some((post) => post.url === '/api/orchestrations/orch-1/stop')).toBe(true),
  )
})

test('See full details opens the run’s Flow in the admin view and remembers it', async () => {
  const router = open('/u/rooms/room-activity-feed')
  fireEvent.click(await screen.findByRole('button', { name: 'See full details' }))
  await waitFor(() => expect(router.state.location.pathname).toBe('/now/flow/brief-orch-1'))
  expect(window.localStorage.getItem('score.view')).toBeNull()
})

test('/ opens the user view in a browser that was left there', async () => {
  window.localStorage.setItem('score.view', 'user')
  const router = open('/')
  await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/u/))
})
