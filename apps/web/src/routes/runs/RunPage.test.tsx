import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  orchestrationEvents,
  orchestrationFixtures,
  orchestrationSnapshot,
} from '../../../../../e2e/orchestration-fixtures.ts'
import { runEvents, runSnapshot, workflowFixtures } from '../../../../../e2e/workflow-fixtures.ts'
import { createQueryClient, StreamContext } from '../../data/query-client.ts'
import { createStreamQueryRegistry } from '../../data/resync.ts'
import { createStreamClient } from '../../data/stream.ts'
import { RunPage } from './RunPage.tsx'

class Source extends EventTarget {
  close() {}
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status })
const dispose: (() => void)[] = []
let fetchImpl: (url: string) => Response | Promise<Response>

beforeEach(() => {
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
  fetchImpl = (url) => {
    if (url === '/api/agents') return json({ asOfSeq: 1, items: [] })
    const fixture = { ...orchestrationFixtures, ...workflowFixtures }[url]
    return fixture === undefined
      ? json({ error: { code: 'not_found', message: 'none' } }, 404)
      : json(fixture)
  }
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => Promise.resolve(fetchImpl(String(input)))),
  )
})

afterEach(() => {
  cleanup()
  dispose.splice(0).forEach((fn) => fn())
  vi.unstubAllGlobals()
})

function mount(briefId: string) {
  const queryClient = createQueryClient()
  const client = createStreamClient({ EventSourceImpl: Source })
  const queries = createStreamQueryRegistry(queryClient, client)
  dispose.push(() => {
    queries.dispose()
    client.close()
    queryClient.clear()
  })
  const router = createMemoryRouter(
    [
      { path: '/runs/:briefId', Component: RunPage },
      { path: '/b', element: <h1>Score</h1> },
    ],
    { initialEntries: [`/runs/${briefId}`] },
  )
  render(
    <QueryClientProvider client={queryClient}>
      <StreamContext value={{ client, queries }}>
        <RouterProvider router={router} />
      </StreamContext>
    </QueryClientProvider>,
  )
}

test('an orchestration brief opens the orchestration run', async () => {
  mount('brief-orch-1')
  expect(screen.getByRole('status').textContent).toContain('Loading the run…')
  await screen.findByRole('log', { name: 'Events' })
  expect(screen.getByRole('button', { name: /Step s2, reviewer, running/ })).toBeTruthy()
})

test('a workflow brief opens the workflow run', async () => {
  mount('brief-wfrun-1')
  await screen.findByRole('log', { name: 'Events' })
  expect(
    screen.getByRole('button', { name: /^Step Draft the notes, builder, succeeded/ }),
  ).toBeTruthy()
})

test('an unknown brief says the run is not available', async () => {
  mount('brief-missing')
  expect((await screen.findByRole('alert')).textContent).toContain('That run isn’t available.')
  expect(screen.getByRole('link', { name: 'Back to Score' }).getAttribute('href')).toBe('/b')
})

test('a failed read offers Try again and recovers', async () => {
  const snapshots = { ...orchestrationFixtures, ...workflowFixtures }
  let fail = true
  fetchImpl = (url) => {
    if (fail && (url === '/api/orchestrations' || url === '/api/workflow-runs'))
      return json({ error: { code: 'unavailable', message: 'none' } }, 500)
    return snapshots[url] === undefined
      ? json({ error: { code: 'not_found', message: 'none' } }, 404)
      : json(snapshots[url])
  }
  mount('brief-orch-1')
  expect((await screen.findByRole('alert', {}, { timeout: 5000 })).textContent).toContain(
    'Couldn’t load this run.',
  )
  fail = false
  screen.getByRole('button', { name: 'Try again' }).click()
  await screen.findByRole('log', { name: 'Events' })
})

// The fixtures are imported so a broken brief link is caught here rather than only by the run pages.
test('the fixtures still carry the brief ids the page matches', () => {
  expect(orchestrationSnapshot.orchestration.briefId).toBe('brief-orch-1')
  expect(runSnapshot.run.briefId).toBe('brief-wfrun-1')
  expect(orchestrationEvents.events.length).toBeGreaterThan(0)
  expect(runEvents.events.length).toBeGreaterThan(0)
})
