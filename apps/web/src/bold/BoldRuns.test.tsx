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
  // 3.15: the job map is the default view; the step diagram is one switch away.
  expect(await screen.findByRole('button', { name: /^Lead layer/ })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Show the step diagram' }))
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

type Snapshot = {
  orchestration: Record<string, unknown> & { stepsList: { id: string }[] }
}
const orchBase = orchestrationFixtures['/api/orchestrations/orch-1'] as Snapshot

function serve(
  edit: (o: Snapshot['orchestration']) => Snapshot['orchestration'],
  onPost: (url: string) => Response | Promise<Response>,
) {
  const snapshot = { ...orchBase, orchestration: edit(orchBase.orchestration) }
  const previous = fetchImpl
  fetchImpl = (url) => (url === '/api/orchestrations/orch-1' ? json(snapshot) : previous(url))
  const posts: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posts.push(String(input))
        return Promise.resolve(onPost(String(input)))
      }
      return Promise.resolve(fetchImpl(String(input)))
    }),
  )
  return posts
}

const withStatus = (statuses: Record<string, string>) => (o: Snapshot['orchestration']) => ({
  ...o,
  stepsList: o.stepsList.map((step) =>
    statuses[step.id] ? { ...step, status: statuses[step.id] } : step,
  ),
})

test('no Stop on a finished step, and none on anything while the run is stopping (3.14)', async () => {
  serve(
    (o) => o,
    () => json(orchBase.orchestration),
  )
  mount('brief-orch-1')
  await screen.findByRole('list', { name: 'Steps' })
  expect(screen.getByRole('button', { name: 'Stop s2' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Stop s1' })).toBeNull()
  cleanup()
  serve(
    (o) => ({ ...o, status: 'stopping' }),
    () => json(orchBase.orchestration),
  )
  mount('brief-orch-1')
  await screen.findByRole('list', { name: 'Steps' })
  expect(screen.queryByRole('button', { name: /^Stop s\d/ })).toBeNull()
})

test('no Stop on an advisor entry (3.14)', async () => {
  serve(
    (o) => ({
      ...o,
      advisor: {
        agentId: 'reviewer',
        consults: [
          {
            stepId: 's2',
            checkpoint: 'repeat_failure',
            reason: 'Failed twice',
            status: 'admitted',
            advice: null,
            createdAt: new Date().toISOString(),
          },
        ],
      },
    }),
    () => json(orchBase.orchestration),
  )
  mount('brief-orch-1')
  await screen.findByText(/Advisor · same failure twice/)
  // The step s2 has its one Stop; the advisor entry adds none.
  expect(screen.getAllByRole('button', { name: /^Stop s2$/ }).length).toBe(1)
})

test('Keep going posts nothing (3.14)', async () => {
  const posts = serve(
    (o) => o,
    () => json(orchBase.orchestration),
  )
  mount('brief-orch-1')
  await screen.findByRole('list', { name: 'Steps' })
  fireEvent.click(screen.getByRole('button', { name: 'Stop s2' }))
  fireEvent.click(screen.getByRole('button', { name: 'Keep going' }))
  expect(screen.queryByText(/Stop s2\? The lead is told/)).toBeNull()
  expect(posts.length).toBe(0)
})

test('a 409 shows under its own step only, and a pending stop disables a second one (3.14)', async () => {
  let release: (response: Response) => void = () => {}
  const pending = new Promise<Response>((resolve) => {
    release = resolve
  })
  const posts = serve(withStatus({ s3: 'queued' }), () => pending)
  mount('brief-orch-1')
  await screen.findByRole('list', { name: 'Steps' })
  fireEvent.click(screen.getByRole('button', { name: 'Stop s2' }))
  fireEvent.click(screen.getByRole('button', { name: 'Stop s2' }))
  const sending = await screen.findByRole('button', { name: 'Stopping…' })
  expect((sending as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(sending)
  expect(posts.length).toBe(1)
  // The other step stays usable while this one is in flight.
  expect((screen.getByRole('button', { name: 'Stop s3' }) as HTMLButtonElement).disabled).toBe(
    false,
  )
  release(json({ error: { code: 'conflict', message: 'moved on' } }, 409))
  const alert = await screen.findByText(/This changed while you were looking/)
  expect(screen.getAllByText(/This changed while you were looking/).length).toBe(1)
  expect(alert.closest('li')?.textContent).toContain('s2')
  expect(alert.closest('li')?.textContent).not.toContain('s3')
})
