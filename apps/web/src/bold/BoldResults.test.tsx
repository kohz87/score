import type { AgentSummary, Job, JobResults } from '@score/contract'
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

function mountView(data = results()) {
  router = createMemoryRouter([
    {
      path: '/',
      element: (
        <BoldResultsView
          results={data.results}
          screens={data.screens}
          agents={agents}
          overview={[
            {
              agent: builder,
              thumbnail: null,
              status: 'working',
              live: true,
              surface: 'terminal',
            },
          ]}
        />
      ),
    },
  ])
  render(<RouterProvider router={router} />)
}

afterEach(() => {
  cleanup()
  router?.dispose()
  router = undefined
  vi.unstubAllGlobals()
})

test('a preview shows its title, live state and a Workbench screen link', () => {
  mountView()
  const card = screen.getByRole('link', { name: 'Open Activity feed in the Workbench' })
  expect(within(card).getByRole('heading', { name: 'Activity feed' })).toBeDefined()
  expect(within(card).getByText('Live preview')).toBeDefined()
  expect(within(card).getByText('http://localhost:5173/feed')).toBeDefined()
  expect(card.getAttribute('href')).toBe('/b?job=job-feed&work=screen')
})

test('what changed is plain words and names who caught the problem', () => {
  mountView()
  const card = screen.getByText('What changed').closest('article') as HTMLElement
  expect(within(card).getByText('Approved')).toBeDefined()
  expect(within(card).getByText('Events in the same millisecond get skipped.')).toBeDefined()
  expect(within(card).getByText('reviewer caught this')).toBeDefined()
  const link = within(card).getByRole('link', { name: 'See the code · 2 files' })
  expect(link.getAttribute('href')).toBe('/b?job=job-feed&work=code')
  expect(card.textContent).not.toContain('api/events.py')
})

test('document and workspace drafts link to the draft tab without showing code', () => {
  mountView()
  const drafts = screen.getAllByText('draft')
  expect(drafts).toHaveLength(2)
  const announcement = screen
    .getByRole('heading', { name: 'Announcement image.md' })
    .closest('article') as HTMLElement
  expect(within(announcement).getByText('Saved to the Library')).toBeDefined()
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

test('an empty panel says nothing is being made yet', () => {
  mountView({ results: [], screens: [] })
  expect(screen.getByRole('region', { name: 'No results yet' })).toBeDefined()
  expect(screen.getByRole('heading', { name: 'Nothing being made yet' })).toBeDefined()
  expect(screen.getByText(/previews, drafts, what changed/)).toBeDefined()
})

test('a job.upserted event refreshes the Results snapshot', async () => {
  let emit: (event: { type: 'job.upserted' }) => void = () => undefined
  const stream = {
    subscribe(listener: (event: { type: 'job.upserted' }) => void) {
      emit = listener
      return () => undefined
    },
    onControl: () => () => undefined,
  }
  let title = 'Activity feed'
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string | URL | Request) => {
      const path = new URL(String(input), 'http://score.test').pathname
      if (path === '/api/team-room')
        return Promise.resolve(
          Response.json({ asOfSeq: 1, room: { id: 'team', name: '#team' }, jobs: [feedJob] }),
        )
      if (path === '/api/jobs/job-feed/results')
        return Promise.resolve(
          Response.json({
            ...feedResults,
            items: feedResults.items.map((card) =>
              card.kind === 'preview' ? { ...card, title } : card,
            ),
          }),
        )
      return Promise.resolve(Response.json({ items: [] }))
    }),
  )
  const queryClient = createQueryClient()
  queryClient.setDefaultOptions({ queries: { retry: false } })
  const queries = createStreamQueryRegistry(
    queryClient,
    stream as unknown as StreamClient,
    immediateFrameScheduler,
  )
  router = createMemoryRouter([
    { path: '/', element: <BoldResults agents={agents} hidden={false} /> },
  ])
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
  expect(await screen.findByText('Live preview')).toBeDefined()
  title = 'Activity feed, second pass'
  act(() => emit({ type: 'job.upserted' }))
  expect(
    await screen.findByRole('heading', { name: 'Activity feed, second pass' }, { timeout: 2000 }),
  ).toBeDefined()
  await waitFor(() => expect(screen.getByText('Live preview')).toBeDefined())
  queries.dispose()
  queryClient.clear()
})
