import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  orchestrationEvents,
  orchestrationFixtures,
  orchestrationSnapshot,
} from '../../../../e2e/orchestration-fixtures.ts'
import { runEvents, runSnapshot, workflowFixtures } from '../../../../e2e/workflow-fixtures.ts'
import { createQueryClient, StreamContext } from '../data/query-client.ts'
import { createStreamQueryRegistry } from '../data/resync.ts'
import { createStreamClient } from '../data/stream.ts'
import { BoldFrameContext } from '../shell/framed-paths.tsx'
import { BoldRuns } from './BoldRuns.tsx'

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

function Harness({ start }: { start: string | null }) {
  const [briefId, setBriefId] = useState<string | null>(start)
  return <BoldRuns briefId={briefId} onOpen={setBriefId} onBack={() => setBriefId(null)} />
}

function mount(start: string | null) {
  const queryClient = createQueryClient()
  const client = createStreamClient({ EventSourceImpl: Source })
  const queries = createStreamQueryRegistry(queryClient, client)
  dispose.push(() => {
    queries.dispose()
    client.close()
    queryClient.clear()
  })
  render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <StreamContext value={{ client, queries }}>
          <BoldFrameContext value={{ look: 'dark' }}>
            <Harness start={start} />
          </BoldFrameContext>
        </StreamContext>
      </QueryClientProvider>
    </MemoryRouter>,
  )
}

test('the list shows both kinds of run and opens one', async () => {
  mount(null)
  const list = await screen.findByRole('list', { name: 'Runs' })
  expect(list.querySelectorAll('li').length).toBe(2)
  fireEvent.click(
    (await screen.findAllByRole('button', { name: /Lead decides/ }))[0] as HTMLElement,
  )
  expect(await screen.findByRole('list', { name: 'Steps' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'All runs' }))
  expect(await screen.findByRole('list', { name: 'Runs' })).toBeTruthy()
})

test('an orchestration run is a thread of steps, with Graph and Log tabs', async () => {
  mount('brief-orch-1')
  const steps = await screen.findByRole('list', { name: 'Steps' })
  expect(steps.querySelectorAll('.bold-run-step').length).toBeGreaterThan(1)
  fireEvent.click(screen.getByRole('tab', { name: 'Graph' }))
  expect(await screen.findByRole('button', { name: /Step s2, reviewer, running/ })).toBeTruthy()
  fireEvent.click(screen.getByRole('tab', { name: 'Log' }))
  expect(await screen.findByRole('log', { name: 'Events' })).toBeTruthy()
})

test('a workflow run is a thread of its nodes, with the graph and log tabs', async () => {
  mount('brief-wfrun-1')
  const steps = await screen.findByRole('list', { name: 'Steps' })
  expect(steps.textContent).toContain('Draft the notes')
  fireEvent.click(screen.getByRole('tab', { name: 'Graph' }))
  expect(
    await screen.findByRole('button', { name: /^Step Draft the notes, builder, succeeded/ }),
  ).toBeTruthy()
  fireEvent.click(screen.getByRole('tab', { name: 'Log' }))
  expect(await screen.findByRole('log', { name: 'Events' })).toBeTruthy()
})

test('an unknown brief says the run is not available', async () => {
  mount('brief-missing')
  expect((await screen.findByRole('alert')).textContent).toContain('That run isn’t available.')
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
  await waitFor(() => expect(screen.getByRole('list', { name: 'Steps' })).toBeTruthy())
})

// The fixtures are imported so a broken brief link is caught here rather than only by the run pages.
test('the fixtures still carry the brief ids the panel matches', () => {
  expect(orchestrationSnapshot.orchestration.briefId).toBe('brief-orch-1')
  expect(runSnapshot.run.briefId).toBe('brief-wfrun-1')
  expect(orchestrationEvents.events.length).toBeGreaterThan(0)
  expect(runEvents.events.length).toBeGreaterThan(0)
})

test('a lead-decides run shows its goal and its plan', async () => {
  mount('brief-orch-1')
  await screen.findByRole('list', { name: 'Steps' })
  const goal = orchestrationSnapshot.orchestration.goal
  expect(screen.getByText(goal)).toBeTruthy()
  expect(screen.getByRole('region', { name: 'Plan' })).toBeTruthy()
})

test('a workflow run names the definition and warns about an agent that changed, before the steps', async () => {
  const changed = {
    ...runSnapshot,
    run: {
      ...runSnapshot.run,
      agentMap: runSnapshot.run.agentMap.map((entry, index) =>
        index === 0 ? { ...entry, status: 'changed' as const } : entry,
      ),
    },
  }
  const base = fetchImpl
  fetchImpl = (url) => (url === '/api/workflow-runs/wfrun-1' ? json(changed) : base(url))
  mount('brief-wfrun-1')
  const warning = await screen.findByRole('list', { name: 'Agents that changed' })
  const steps = screen.getByRole('list', { name: 'Steps' })
  expect(warning.textContent).toContain('replaced')
  expect(warning.compareDocumentPosition(steps) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  const facts = screen.getByRole('region', { name: 'This run' })
  expect(facts.querySelector(`a[href*="/recipes/${runSnapshot.run.workflowId}"]`)).toBeTruthy()
  expect(facts.textContent).toContain('replaced since')
})

test('a running step quiet for over 5 minutes shows the stuck card, and Stop asks first then posts the revision (3.14)', async () => {
  const quiet = new Date(Date.now() - 12 * 60_000).toISOString()
  const base = orchestrationFixtures['/api/orchestrations/orch-1'] as {
    orchestration: { revision: number; stepsList: { id: string }[] }
  }
  const snapshot = {
    ...base,
    orchestration: {
      ...base.orchestration,
      stepsList: base.orchestration.stepsList.map((step) =>
        step.id === 's2' ? { ...step, lastActivityAt: quiet } : step,
      ),
    },
  }
  const posts: { url: string; body: unknown }[] = []
  const previous = fetchImpl
  fetchImpl = (url) => (url === '/api/orchestrations/orch-1' ? json(snapshot) : previous(url))
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posts.push({ url: String(input), body: JSON.parse(String(init.body)) })
        return Promise.resolve(json(base.orchestration))
      }
      return Promise.resolve(fetchImpl(String(input)))
    }),
  )
  mount('brief-orch-1')
  const card = await screen.findByText(/has been quiet for 12 min/)
  expect(card.closest('[data-protected]')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Stop this step' }))
  expect(screen.getByText(/Stop s2\? The lead is told/)).toBeTruthy()
  expect(posts.length).toBe(0)
  fireEvent.click(screen.getByRole('button', { name: 'Stop s2' }))
  await waitFor(() => expect(posts.length).toBe(1))
  expect(posts[0]).toEqual({
    url: '/api/orchestrations/orch-1/steps/s2/stop',
    body: { orchestrationRevision: base.orchestration.revision },
  })
})

test('a recently active running step has no stuck card but still has a small Stop (3.14)', async () => {
  mount('brief-orch-1')
  await screen.findByRole('list', { name: 'Steps' })
  expect(screen.queryByText(/has been quiet/)).toBeNull()
  expect(screen.getByRole('button', { name: 'Stop s2' })).toBeTruthy()
})
