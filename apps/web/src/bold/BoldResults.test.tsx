import type {
  AgentSummary,
  Job,
  JobResults,
  ResultCard,
  StreamEvent,
  WatchOverviewItem,
} from '@score/contract'
import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, expect, test, vi } from 'vitest'
import { createQueryClient, StreamContext } from '../data/query-client.ts'
import { createStreamQueryRegistry, immediateFrameScheduler } from '../data/resync.ts'
import type { StreamClient } from '../data/stream.ts'
import { BoldResults, BoldResultsView } from './BoldResults.tsx'

const builder: AgentSummary = {
  id: 'builder',
  name: 'builder',
  role: 'Builds features',
  style: { color: '#19C39A', shape: 'triangle' },
  status: 'working',
  activity: 'Writing the feed',
  model: { id: 'fake-model', label: 'Demo model' },
  served: true,
}

const reviewer: AgentSummary = {
  id: 'reviewer',
  name: 'reviewer',
  role: 'Reviews changes',
  style: { color: '#FFB61E', shape: 'diamond' },
  status: 'idle',
  activity: null,
  model: { id: 'fake-model', label: 'Demo model' },
  served: true,
}

const designer: AgentSummary = {
  id: 'designer',
  name: 'designer',
  role: 'Designs interfaces',
  style: { color: '#FF6B8A', shape: 'square' },
  status: 'idle',
  activity: null,
  model: { id: 'fake-model', label: 'Demo model' },
  served: true,
}

const agents = [builder, reviewer, designer]

function job(id: string, title: string): Job {
  return {
    id,
    roomId: 'team',
    title,
    state: 'working',
    holderAgentId: 'builder',
    isDefault: false,
    exchangeBudget: 8,
    jobTurnLimit: 40,
    unread: 0,
    activeAgents: ['builder'],
    lastMessageAt: '2026-10-24T10:00:00.000Z',
    messageCount: 4,
    summary: null,
    source: null,
    reportBack: null,
    spendCapUsd: null,
    recipe: null,
    createdAt: '2026-10-24T09:00:00.000Z',
    updatedAt: '2026-10-24T10:00:00.000Z',
  }
}

const feedJob = job('job-feed', 'Activity feed')
const notesJob = job('job-notes', 'Release notes 2.4')

const feedResults: JobResults = {
  asOfSeq: 12,
  items: [
    {
      kind: 'preview',
      id: 'preview:builder:8',
      agentId: 'builder',
      url: 'http://localhost:5173/feed',
      title: 'Activity feed',
      imageUrl: null,
      live: true,
      at: '2026-10-24T10:03:00.000Z',
    },
    {
      kind: 'change',
      id: 'change:job-feed',
      title: 'Activity feed',
      authors: ['builder'],
      state: 'approved',
      whatChanged: [
        {
          text: 'Events in the same millisecond get skipped.',
          by: 'reviewer',
          caught: true,
        },
        { text: 'Approved by reviewer', by: 'reviewer', caught: false },
      ],
      files: [
        { path: 'api/events.py', added: 15, removed: 3, by: ['builder'] },
        { path: 'api/test_events.py', added: 20, removed: 0, by: ['builder'] },
      ],
      at: '2026-10-24T10:02:00.000Z',
    },
  ],
  screens: [
    {
      agentId: 'builder',
      seq: 8,
      surface: 'terminal',
      caption: 'Ran pnpm test api/events',
      live: true,
      at: '2026-10-24T10:03:00.000Z',
    },
  ],
}

const notesResults: JobResults = {
  asOfSeq: 13,
  items: [
    {
      kind: 'draft',
      id: 'draft:notes:document',
      agentId: 'designer',
      title: 'Announcement image.md',
      target: { kind: 'document', mediaId: 'media-notes' },
      at: '2026-10-24T09:58:00.000Z',
    },
    {
      kind: 'draft',
      id: 'draft:notes:workspace',
      agentId: 'designer',
      title: 'release-notes.md',
      target: { kind: 'workspace', path: 'docs/release-notes.md' },
      at: '2026-10-24T09:57:00.000Z',
    },
  ],
  screens: [],
}

function results(overrides?: {
  feed?: JobResults
  notes?: JobResults
  jobs?: Job[]
  screens?: { job: Job; screen: JobResults['screens'][number] }[]
}) {
  const feed = overrides?.feed ?? feedResults
  const notes = overrides?.notes ?? notesResults
  return {
    results: [
      { job: feedJob, result: feed },
      { job: notesJob, result: notes },
    ],
    screens: overrides?.screens ?? [
      { job: feedJob, screen: feed.screens[0]! },
      ...notes.screens.map((screen) => ({ job: notesJob, screen })),
    ],
  }
}

let router: ReturnType<typeof createMemoryRouter> | undefined
let liveCleanup: (() => void) | undefined

function mountView(
  data = results(),
  overview: WatchOverviewItem[] = [
    {
      agent: builder,
      thumbnail: null,
      status: 'working',
      live: true,
      surface: 'terminal',
    },
  ],
) {
  router = createMemoryRouter([
    {
      path: '/',
      element: (
        <BoldResultsView
          results={data.results}
          screens={data.screens}
          agents={agents}
          overview={overview}
        />
      ),
    },
  ])
  render(<RouterProvider router={router} />)
}

afterEach(() => {
  cleanup()
  liveCleanup?.()
  liveCleanup = undefined
  router?.dispose()
  router = undefined
  vi.unstubAllGlobals()
})

test('a preview shows its title, live state and a Workbench screen link', () => {
  mountView()
  const card = screen
    .getByRole('heading', { name: 'Activity feed' })
    .closest('article') as HTMLElement
  expect(within(card).getByRole('heading', { name: 'Activity feed' })).toBeDefined()
  expect(within(card).getByText('Live preview')).toBeDefined()
  expect(within(card).getByText('http://localhost:5173/feed')).toBeDefined()
  expect(
    within(card)
      .getByRole('link', { name: 'Open Activity feed in the Workbench' })
      .getAttribute('href'),
  ).toBe('/b?job=job-feed&work=screen')
})

test('what changed is plain words and names who caught the problem', () => {
  mountView()
  const card = screen.getByText('What changed').closest('article') as HTMLElement
  expect(within(card).getByText('Approved')).toBeDefined()
  expect(card.textContent).toContain('Events in the same millisecond get skipped.')
  expect(within(card).getByText('reviewer caught this')).toBeDefined()
  const link = within(card).getByRole('link', { name: 'See the code · 2 files' })
  expect(link.getAttribute('href')).toBe('/b?job=job-feed&work=code')
  expect(card.textContent).not.toContain('api/events.py')
  for (const heading of screen.getAllByRole('heading'))
    expect(heading.closest('a, span')).toBeNull()
})

test('a waiting change is a labelled badge, not a control, and fileless changes hide the code link', () => {
  const change = feedResults.items.find(
    (card): card is Extract<ResultCard, { kind: 'change' }> => card.kind === 'change',
  )!
  const waiting: JobResults = {
    ...feedResults,
    items: [{ ...change, state: 'waiting_on_you', files: [] }],
  }
  mountView(results({ feed: waiting }))
  const card = screen.getByText('What changed').closest('article') as HTMLElement
  const badge = within(card).getByText('Needs you')
  expect(badge.tagName).toBe('SPAN')
  expect(within(card).queryByRole('button', { name: 'Needs you' })).toBeNull()
  expect(within(card).queryByRole('link', { name: /See the code/ })).toBeNull()
})

test('two change cards for one job are both kept and both labels stay on its preview', () => {
  const preview = feedResults.items.find(
    (card): card is Extract<ResultCard, { kind: 'preview' }> => card.kind === 'preview',
  )!
  const change = feedResults.items.find(
    (card): card is Extract<ResultCard, { kind: 'change' }> => card.kind === 'change',
  )!
  const second = {
    ...change,
    id: 'change:job-feed:second',
    state: 'in_review' as const,
    at: '2026-10-24T10:01:00.000Z',
  }
  mountView(results({ feed: { ...feedResults, items: [preview, change, second] } }))
  expect(screen.getAllByText('What changed')).toHaveLength(2)
  const previewCard = screen
    .getByRole('heading', { name: 'Activity feed' })
    .closest('article') as HTMLElement
  expect(within(previewCard).getByText('Approved')).toBeDefined()
  expect(within(previewCard).getByText('In review')).toBeDefined()
})

test('a saved preview says the run finished only when the job is known to be done', () => {
  const preview = feedResults.items.find(
    (card): card is Extract<ResultCard, { kind: 'preview' }> => card.kind === 'preview',
  )!
  const saved = { ...preview, live: false }
  const working = job('job-preview', 'Preview')
  mountView({
    results: [{ job: working, result: { asOfSeq: 1, items: [saved], screens: [] } }],
    screens: [],
  })
  expect(screen.queryByText(/The run has finished/)).toBeNull()

  cleanup()
  mountView({
    results: [
      { job: { ...working, state: 'done' }, result: { asOfSeq: 1, items: [saved], screens: [] } },
    ],
    screens: [],
  })
  expect(screen.getByText(/The run has finished/)).toBeDefined()
})

test('document and workspace drafts link to the draft tab without showing code', () => {
  mountView()
  const drafts = screen.getAllByText('draft')
  expect(drafts).toHaveLength(2)
  const announcement = screen
    .getByRole('heading', { name: 'Announcement image.md' })
    .closest('article') as HTMLElement
  expect(within(announcement).getByText('Attached document')).toBeDefined()
  expect(within(announcement).getByText('designer')).toBeDefined()
  expect(
    within(announcement).getByRole('link', { name: 'Open the draft' }).getAttribute('href'),
  ).toBe('/b?job=job-notes&work=draft')
  const workspace = screen
    .getByRole('heading', { name: 'release-notes.md' })
    .closest('article') as HTMLElement
  expect(within(workspace).getByText('In the workspace')).toBeDefined()
  expect(workspace.textContent).not.toContain('docs/release-notes.md')
})

test('small screens reuse the Watch miniature and identify the agent by glyph and name', () => {
  mountView()
  const screens = screen.getByRole('region', { name: 'Screens' })
  const builderScreen = within(screens).getByRole('link', { name: 'Watch builder’s screen' })
  expect(builderScreen.getAttribute('href')).toBe('/b?job=job-feed&work=screen')
  expect(builderScreen.textContent).toContain('builder')
  expect(builderScreen.querySelector('.agent-glyph')).not.toBeNull()
  expect(within(builderScreen).getByLabelText('Live')).toBeDefined()
})

test("a screen tile uses the card's surface and live state, and only a matching overview thumbnail", () => {
  mountView(results(), [
    {
      agent: builder,
      thumbnail: '/api/media/other-job',
      status: 'working',
      live: true,
      surface: 'browser',
    },
  ])
  const screens = screen.getByRole('region', { name: 'Screens' })
  const builderScreen = within(screens).getByRole('link', { name: 'Watch builder’s screen' })
  expect(within(builderScreen).queryByRole('img')).toBeNull()
  expect(builderScreen.querySelector('.watch-mini__page')).toBeNull()
  expect(within(builderScreen).getByLabelText('Live')).toBeDefined()

  cleanup()
  mountView(results(), [
    {
      agent: builder,
      thumbnail: '/api/media/this-job',
      status: 'working',
      live: true,
      surface: 'terminal',
    },
  ])
  expect(
    within(screen.getByRole('region', { name: 'Screens' }))
      .getByRole('img')
      .getAttribute('src'),
  ).toBe('/api/media/this-job')
})

test('an empty panel says nothing is being made yet', () => {
  mountView({ results: [], screens: [] })
  expect(screen.getByRole('region', { name: 'No results yet' })).toBeDefined()
  expect(screen.getByRole('heading', { name: 'Nothing being made yet' })).toBeDefined()
  expect(screen.getByText(/previews, drafts, what changed/)).toBeDefined()
})

test('an error always offers Retry, including beside Results that did load', () => {
  const retry = vi.fn()
  router = createMemoryRouter([
    {
      path: '/',
      element: <BoldResultsView {...results()} agents={agents} failed onRetry={retry} />,
    },
  ])
  render(<RouterProvider router={router} />)
  const inline = screen.getByRole('alert')
  within(inline).getByRole('button', { name: 'Retry' }).click()
  expect(retry).toHaveBeenCalledOnce()

  cleanup()
  router = createMemoryRouter([
    {
      path: '/',
      element: <BoldResultsView results={[]} screens={[]} agents={agents} failed onRetry={retry} />,
    },
  ])
  render(<RouterProvider router={router} />)
  const full = screen.getByRole('alert')
  within(full).getByRole('button', { name: 'Retry' }).click()
  expect(retry).toHaveBeenCalledTimes(2)
})

const teamRoom = {
  id: 'team',
  name: '#team',
  kind: 'room',
  leadAgentId: 'lead',
  members: ['lead', 'builder', 'reviewer', 'designer'],
  unread: 0,
  activeAgents: [],
  channels: [],
  role: 'team',
  routing: 'exchanges',
}

function mountLiveResults({
  jobs = [feedJob, notesJob],
  initialEntry = '/',
  hidden = false,
  reply,
}: {
  jobs?: Job[]
  initialEntry?: string
  hidden?: boolean
  reply?: (jobId: string, call: number) => Response | Promise<Response>
} = {}) {
  const listeners = new Set<(event: StreamEvent) => void>()
  const stream = {
    subscribe(listener: (event: StreamEvent) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    onControl: () => () => undefined,
  }
  const resultCalls: string[] = []
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const path = new URL(String(input), 'http://score.test').pathname
    if (path === '/api/team-room') return Response.json({ asOfSeq: 1, room: teamRoom, jobs })
    if (path === `/api/rooms/${teamRoom.id}/jobs`) return Response.json({ asOfSeq: 1, items: jobs })
    if (path === '/api/watch/overview') return Response.json({ items: [] })
    const match = /^\/api\/jobs\/([^/]+)\/results$/.exec(path)
    if (match) {
      const jobId = decodeURIComponent(match[1]!)
      resultCalls.push(jobId)
      if (reply) return reply(jobId, resultCalls.filter((id) => id === jobId).length)
      const result = jobId === notesJob.id ? notesResults : feedResults
      return Response.json(result)
    }
    throw new Error(`Unexpected request: ${path}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  const queryClient = createQueryClient()
  queryClient.setDefaultOptions({ queries: { retry: false } })
  const queries = createStreamQueryRegistry(
    queryClient,
    stream as unknown as StreamClient,
    immediateFrameScheduler,
  )
  router = createMemoryRouter(
    [{ path: '/', element: <BoldResults agents={agents} hidden={hidden} /> }],
    { initialEntries: [initialEntry] },
  )
  render(
    <QueryClientProvider client={queryClient}>
      <StreamContext
        value={{
          client: stream as unknown as StreamClient,
          queries,
        }}
      >
        <RouterProvider router={router} />
      </StreamContext>
    </QueryClientProvider>,
  )
  liveCleanup = () => {
    queries.dispose()
    queryClient.clear()
  }
  return {
    emit(event: StreamEvent) {
      for (const listener of listeners) listener(event)
    },
    fetchMock,
    queryClient,
    resultCalls,
  }
}

const event = (type: string, data: unknown, seq = 1): StreamEvent =>
  ({ seq, ts: '2026-10-24T10:00:00.000Z', type, data }) as StreamEvent

test('events refresh only the named job, coalesce a burst and ignore token updates', async () => {
  const mounted = mountLiveResults()
  expect(await screen.findByText('Live preview')).toBeDefined()
  await waitFor(() => expect(mounted.resultCalls).toHaveLength(2))

  act(() => {
    mounted.emit(event('job.upserted', feedJob, 2))
    mounted.emit(event('job.upserted', feedJob, 3))
    mounted.emit(event('message.updated', { roomId: 'team', messageId: 'm1' }, 4))
  })
  await new Promise((resolve) => setTimeout(resolve, 1100))
  await waitFor(() => expect(mounted.resultCalls.filter((id) => id === feedJob.id)).toHaveLength(2))
  expect(mounted.resultCalls.filter((id) => id === notesJob.id)).toHaveLength(1)
})

test('a watch frame refreshes all Results and a later success clears an error and its Retry', async () => {
  let fail = true
  const mounted = mountLiveResults({
    jobs: [feedJob],
    reply: () =>
      fail
        ? Response.json({ error: { code: 'unavailable', message: 'Try later' } }, { status: 503 })
        : Response.json(feedResults),
  })
  expect((await screen.findByRole('alert')).textContent).toContain('Couldn’t load the Results')
  expect(screen.getByRole('button', { name: 'Retry' })).toBeDefined()
  fail = false
  act(() =>
    mounted.emit(
      event(
        'watch.frame',
        {
          seq: 99,
          at: '2026-10-24T10:00:00.000Z',
          agentId: 'builder',
          runId: 'run-feed',
          surface: 'terminal',
          terminal: { cwd: '/app', command: 'pnpm test', output: 'ok', status: 'ok' },
          caption: 'Ran the tests',
        },
        5,
      ),
    ),
  )
  expect(await screen.findByText('Live preview', {}, { timeout: 2000 })).toBeDefined()
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
})

test('a selected job is the only one fetched', async () => {
  const mounted = mountLiveResults({
    jobs: [feedJob, notesJob],
    initialEntry: '/?job=job-feed',
  })
  expect(await screen.findByText('Live preview')).toBeDefined()
  await waitFor(() => expect(mounted.resultCalls).toEqual([feedJob.id]))
  expect(screen.queryByText('Release notes 2.4')).toBeNull()
})

test('closed jobs are not fetched', async () => {
  const closed = { ...notesJob, id: 'job-closed', title: 'Closed job', state: 'closed' as const }
  const allOpen = mountLiveResults({ jobs: [feedJob, closed] })
  expect(await screen.findByText('Live preview')).toBeDefined()
  await waitFor(() => expect(allOpen.resultCalls).toEqual([feedJob.id]))
  expect(screen.queryByText('Closed job')).toBeNull()
})

test('a hidden Work panel does not ask for Results', async () => {
  const mounted = mountLiveResults({ hidden: true })
  const invalidate = vi.spyOn(mounted.queryClient, 'invalidateQueries')
  await waitFor(() => expect(mounted.fetchMock).toHaveBeenCalled())
  act(() => mounted.emit(event('job.upserted', feedJob, 2)))
  expect(mounted.resultCalls).toEqual([])
  expect(invalidate).not.toHaveBeenCalled()
})
