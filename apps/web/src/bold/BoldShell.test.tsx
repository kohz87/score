import type { AgentSummary } from '@score/contract'
import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { createMemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { App, appRoutes } from '../App.tsx'
import { createQueryClient, StreamContext } from '../data/query-client.ts'
import { immediateFrameScheduler, createStreamQueryRegistry } from '../data/resync.ts'
import { createStreamClient } from '../data/stream.ts'
import { jsonResponse, reportFixture } from '../test/reports-fixtures.ts'

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
    activity: 'Adding feed pagination',
    model: { id: 'fake-model', label: 'Demo model' },
    served: true,
  },
  {
    id: 'reviewer',
    name: 'reviewer',
    role: 'Reviews changes',
    style: { color: '#FFB61E', shape: 'diamond' },
    status: 'waiting',
    activity: null,
    model: { id: 'fake-model', label: 'Demo model' },
    served: true,
  },
  {
    id: 'designer',
    name: 'designer',
    role: 'Designs interfaces',
    style: { color: '#FF6B8A', shape: 'square' },
    status: 'idle',
    activity: null,
    model: { id: 'fake-model', label: 'Demo model' },
    served: true,
  },
]

vi.mock('../notifications/NotificationBridge.tsx', () => ({
  NotificationBridge: () => <span data-testid="notification-bridge" />,
}))
vi.mock('../pwa/UpdateBanner.tsx', () => ({
  UpdateBanner: () => <span data-testid="update-banner" />,
}))

class Source extends EventTarget {
  close() {}
}

let phone = false
/** Under 1280px: the Graph tab folds the chat list. */
let narrow = false
let approvalFixture = false
let terminalFixture: { terminal: boolean; terminalUnavailable: string | null } | null = null
/** Agents the roster read adds after the four (a removed one, one setting up). */
let extraAgents: AgentSummary[] = []
let teamRoomFixture: unknown = null
/** 3.23.0: the jobs of the team room and the run summaries, for the tests that start from a run. */
let runJobs: unknown[] = []
let runSummaries: unknown[] = []
/** 3.25.0: what `/api/jobs/:id/results` and `/workbench` answer (any job). */
let resultsFixture: unknown = { asOfSeq: 1, items: [], screens: [] }
let workbenchFixture: unknown = null
const disposers: (() => void)[] = []

beforeEach(() => {
  phone = false
  narrow = false
  approvalFixture = false
  terminalFixture = null
  extraAgents = []
  teamRoomFixture = null
  runJobs = []
  runSummaries = []
  resultsFixture = { asOfSeq: 1, items: [], screens: [] }
  workbenchFixture = null
  window.localStorage.clear()
  window.history.replaceState(null, '', '/')
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches:
          query === '(max-width: 860px)' ? phone : query === '(max-width: 1279px)' ? narrow : false,
        media: query,
        addEventListener() {},
        removeEventListener() {},
      }) as unknown as MediaQueryList,
  )
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://x')
      url.searchParams.delete('tz')
      if (url.pathname === '/api/session/security' && terminalFixture)
        return Promise.resolve(
          Response.json({ passwordSet: true, origins: [], ...terminalFixture }),
        )
      if (url.pathname === '/api/agents')
        return Promise.resolve(Response.json({ asOfSeq: 1, items: [...agents, ...extraAgents] }))
      if (url.pathname === '/api/team-room' && teamRoomFixture)
        return Promise.resolve(Response.json({ asOfSeq: 1, ...(teamRoomFixture as object) }))
      if (url.pathname === '/api/approvals' && approvalFixture)
        return Promise.resolve(
          Response.json({
            asOfSeq: 1,
            items: [
              {
                id: 'approval-notes',
                origin: 'score-run',
                phase: 'human_pending',
                status: 'pending',
                actionable: true,
                linkedTo: null,
                agentId: 'builder',
                title: 'May I install a package?',
                command: 'npm install ws@8',
                cwd: '~/app',
                description: 'The notes job needs ws.',
                choices: ['once', 'deny'],
                createdAt: '2026-10-24T09:03:00.000Z',
                expiresAt: null,
                decision: null,
                delivery: 'none',
                blocking: null,
                refs: [],
              },
            ],
            nextCursor: null,
          }),
        )
      if (url.pathname === '/api/knowledge')
        return Promise.resolve(
          Response.json({
            vault: '/vault',
            notes: 1,
            gitAvailable: true,
            agentAccess: true,
            memoryNotes: true,
            documents: 0,
            documentBytes: 0,
            moveIssue: null,
          }),
        )
      if (url.pathname === '/api/knowledge/tree')
        return Promise.resolve(
          Response.json({
            folders: ['Decisions'],
            notes: [
              {
                path: 'Decisions/Source.md',
                title: 'Source',
                mtime: '2026-10-24T09:00:00.000Z',
                lastAuthor: 'you',
              },
            ],
            documents: [],
          }),
        )
      if (url.pathname === '/api/knowledge/notes/Decisions/Source.md')
        return Promise.resolve(
          Response.json({
            path: 'Decisions/Source.md',
            title: 'Source',
            frontmatter: {},
            body: '# Source\n\nThe source of truth.\n',
            etag: 'etag-source',
            mtime: '2026-10-24T09:00:00.000Z',
            links: [],
            backlinks: [],
            lastAuthor: 'you',
            versioned: true,
            history: 'unchanged',
          }),
        )
      if (/^\/api\/jobs\/[^/]+\/results$/.test(url.pathname))
        return Promise.resolve(Response.json(resultsFixture))
      if (/^\/api\/jobs\/[^/]+\/workbench$/.test(url.pathname) && workbenchFixture)
        return Promise.resolve(Response.json(workbenchFixture))
      if (url.pathname === '/api/team-rooms' && runJobs.length > 0)
        return Promise.resolve(
          Response.json({
            asOfSeq: 1,
            items: [
              {
                id: 'team-room',
                name: 'Team room',
                kind: 'room',
                leadAgentId: 'lead',
                members: agents.map((agent) => agent.id),
                unread: 0,
                activeAgents: [],
                channels: [],
                role: 'team',
                routing: 'exchanges',
              },
            ],
          }),
        )
      if (url.pathname === '/api/rooms/team-room/messages' && runJobs.length > 0)
        return Promise.resolve(
          Response.json({ asOfSeq: 1, items: [], nextCursor: null, jobId: null }),
        )
      if (url.pathname === '/api/rooms/team-room/jobs' && runJobs.length > 0)
        return Promise.resolve(Response.json({ asOfSeq: 1, items: runJobs, nextCursor: null }))
      if (url.pathname === '/api/orchestrations')
        return Promise.resolve(Response.json({ asOfSeq: 1, items: runSummaries }))
      if (url.pathname === '/api/workflow-runs')
        return Promise.resolve(Response.json({ asOfSeq: 1, items: [] }))
      if (url.pathname === '/api/orchestrations/fence')
        return Promise.resolve(
          Response.json({
            fenced: false,
            reason: null,
            untrustedHistory: false,
            revision: 1,
            since: null,
            items: [],
            journal: { ok: true, entries: 0, bytes: 0, sizeAlarm: false },
          }),
        )
      if (url.pathname === '/api/rooms/team-room/messages' && approvalFixture)
        return Promise.resolve(
          Response.json({
            asOfSeq: 1,
            items: [
              {
                id: 'approval:approval-notes',
                roomId: 'team-room',
                jobId: 'job-notes',
                author: { kind: 'agent', agentId: 'builder' },
                to: [],
                parts: [{ kind: 'approval', approvalId: 'approval-notes' }],
                createdAt: '2026-10-24T09:03:00.000Z',
                streaming: false,
                refs: [],
              },
            ],
            nextCursor: null,
            jobId: 'job-notes',
          }),
        )
      if (url.pathname === '/api/watch/overview')
        return Promise.resolve(
          Response.json({
            items: agents.map((agent) => ({
              agent,
              thumbnail: null,
              status: 'Idle',
              live: false,
              surface: null,
            })),
          }),
        )
      if (url.pathname === '/api/now')
        return Promise.resolve(
          Response.json({
            asOfSeq: 1,
            now: new Date().toISOString(),
            paused: false,
            headline: { working: 1, needsYou: 0, text: 'One agent is working.' },
            lanes: [],
            handoffs: [],
            focusApproval: null,
            thread: null,
            madeToday: [],
          }),
        )
      if (url.pathname === '/api/reports')
        return Promise.resolve(
          jsonResponse(
            reportFixture((url.searchParams.get('range') as 'today' | '7d' | '30d' | null) ?? '7d'),
          ),
        )
      return Promise.resolve(
        Response.json(
          {
            asOfSeq: 0,
            items: [],
            rooms: [],
            directs: [],
            projects: [],
            columns: { planned: [], working: [], in_review: [], needs_you: [], done: [] },
          },
          { status: 200 },
        ),
      )
    }),
  )
})

afterEach(() => {
  cleanup()
  disposers.splice(0).forEach((dispose) => dispose())
  vi.unstubAllGlobals()
})

function open(
  path: string,
  teamJobs: {
    id: string
    title: string
    state: 'working' | 'waiting_on_you'
    isDefault: boolean
    recipe?: { kind: 'orchestration' | 'workflow'; ref: string }
  }[] = [],
) {
  const queryClient = createQueryClient()
  // The shell reads the team room before deciding between first run and the room. These frame tests start with that
  // read already cached, as it is on a normal navigation inside the app; the first-run spec covers the cold read.
  const teamRoom = {
    room: {
      id: 'team-room',
      name: 'Team room',
      kind: 'room',
      leadAgentId: 'lead',
      members: agents.map((agent) => agent.id),
      unread: 0,
      activeAgents: [],
      channels: [],
      role: 'team',
      routing: 'exchanges',
    },
    jobs: teamJobs.map((job) => ({
      roomId: 'team-room',
      holderAgentId: 'lead',
      exchangeBudget: 8,
      jobTurnLimit: 40,
      unread: 0,
      activeAgents: [],
      lastMessageAt: null,
      messageCount: 0,
      summary: null,
      source: null,
      reportBack: null,
      spendCapUsd: null,
      recipe: null,
      createdAt: '2026-10-24T09:00:00.000Z',
      updatedAt: '2026-10-24T09:00:00.000Z',
      ...job,
    })),
  }
  if (approvalFixture || runJobs.length > 0) teamRoomFixture = teamRoom
  queryClient.setQueryData(['bold', 'team-room', null], { asOfSeq: 1, data: teamRoom })
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

test('/b draws the frame and the dock', async () => {
  open('/b')
  expect(screen.getByRole('banner')).toBeDefined()
  expect(screen.getByRole('main')).toBeDefined()
  expect(screen.getByRole('complementary', { name: 'Side panel' })).toBeDefined()
  expect(screen.getByRole('button', { name: 'Score, go to the team room' })).toBeDefined()
  expect(screen.getByRole('button', { name: 'Agents' })).toBeDefined()
  // The title has no switcher: the chat list switches chats, and the room menu keeps the older ones.
  expect(screen.getByRole('heading', { name: 'Team room' })).toBeDefined()
  expect(screen.queryByRole('button', { name: 'Team room' })).toBeNull()

  const dock = screen.getByRole('group', { name: /Your team/ })
  expect(within(dock).queryByText('Rings show progress')).toBeNull()
  await within(dock).findByRole('button', { name: 'One to one with builder, working' })
  const rings = within(dock).getAllByRole('button')
  expect(rings).toHaveLength(agents.length)
  for (const agent of agents) {
    const ring = within(dock).getByRole('button', {
      name: new RegExp(`^One to one with ${agent.id}, `),
    })
    expect(ring.querySelector('.agent-glyph')).not.toBeNull()
    // The frame's glyph is the shape without eyes, as the prototype draws it.
    expect(ring.querySelector('.agent-glyph__eyes')).toBeNull()
  }

  const builder = within(dock).getByRole('button', { name: 'One to one with builder, working' })
  expect(builder.hasAttribute('data-progress')).toBe(false)
  expect(builder.getAttribute('style')).toContain('var(--line)')
  expect(builder.getAttribute('style')).not.toContain('conic-gradient')
  const idle = within(dock).getByRole('button', { name: 'One to one with lead, free' })
  expect(idle.hasAttribute('data-progress')).toBe(false)
  expect(idle.getAttribute('style')).not.toContain('conic-gradient')
  const needs = within(dock).getByRole('button', {
    name: 'One to one with reviewer, needs you',
  })
  expect(needs.className).toContain('needs')
})

test('a phone keeps the wordmark and avatar, shows the tab bar and opens the side panel as a sheet', async () => {
  phone = true
  open('/b?open=1')
  const nav = screen.getByRole('navigation', { name: 'Main' })
  for (const label of ['Chats', 'Agents', 'Knowledge', 'Search', 'Settings'])
    expect(within(nav).getByRole('button', { name: label })).toBeDefined()
  expect(screen.queryByRole('complementary', { name: 'Side panel' })).toBeNull()
  expect(screen.queryByRole('group', { name: /Your team/ })).toBeNull()
  expect(screen.getByRole('button', { name: 'Score, go to the team room' })).toBeDefined()
  expect(screen.getByText('Y')).toBeDefined()
  const openPanel = screen.getByRole('button', { name: 'Chat info' })
  expect(openPanel.getAttribute('aria-expanded')).toBe('false')
  fireEvent.click(openPanel)
  const panel = screen.getByRole('complementary', { name: 'Side panel' })
  expect(panel.getAttribute('aria-modal')).toBe('true')
  expect(openPanel.getAttribute('aria-expanded')).toBe('true')
  expect(screen.getByRole('banner').hasAttribute('inert')).toBe(true)
  expect(nav.hasAttribute('inert')).toBe(true)
  expect(document.querySelector('.roomcol')?.hasAttribute('inert')).toBe(true)
  const close = screen.getByRole('button', { name: 'Close side panel' })
  await waitFor(() => expect(document.activeElement).toBe(close))
  fireEvent.click(close)
  expect(screen.queryByRole('complementary', { name: 'Side panel' })).toBeNull()
  expect(document.getElementById('bold-side-panel')).not.toBeNull()
  expect(document.querySelector('.bold-sidecol')?.hasAttribute('hidden')).toBe(true)
  expect(screen.getByRole('banner').hasAttribute('inert')).toBe(false)
  expect(nav.hasAttribute('inert')).toBe(false)
  expect(document.querySelector('.roomcol')?.hasAttribute('inert')).toBe(false)
  const openPanelAgain = screen.getByRole('button', { name: 'Chat info' })
  await waitFor(() => expect(document.activeElement).toBe(openPanelAgain))
})

test('the phone Room badge waits for the team room and counts the job in the URL', async () => {
  phone = true
  approvalFixture = true
  open('/b?job=job-notes', [
    { id: 'job-default', title: 'Team room', state: 'working', isDefault: true },
    { id: 'job-notes', title: 'Release notes', state: 'waiting_on_you', isDefault: false },
  ])
  const nav = screen.getByRole('navigation', { name: 'Main' })
  const room = within(nav).getByRole('button', { name: /^Chats/ })
  // The cached team-room read is already successful in this harness; the selected job has one approval to answer.
  await waitFor(() => expect(room.getAttribute('aria-label')).toBe('Chats, 1 need you'))
  const badge = room.querySelector('.bold-tab-count')
  expect(badge?.textContent).toBe('1')
  expect(badge?.getAttribute('data-protected')).toBe('inline-flex')
})

// 3.19.1 review: below 1100px the team rings hide, so the top bar's Room button carries the needs-you count (CSS shows it).
test('the desktop Room button carries the needs-you count, protected, for windows too narrow for the rings', async () => {
  approvalFixture = true
  open('/b?job=job-notes', [
    { id: 'job-default', title: 'Team room', state: 'working', isDefault: true },
    { id: 'job-notes', title: 'Release notes', state: 'waiting_on_you', isDefault: false },
  ])
  const nav = screen.getByRole('navigation', { name: 'Main' })
  const room = within(nav).getByRole('button', { name: /^Chats/ })
  await waitFor(() => expect(room.querySelector('.bold-nav-count')?.textContent).toBe('1'))
  expect(room.querySelector('.bold-nav-count')?.getAttribute('data-protected')).toBe('inline-flex')
})

test('Agents, Knowledge and Settings are real pages, and the search button and Ctrl+K open the palette', async () => {
  open('/b')
  fireEvent.click(screen.getByRole('button', { name: 'Agents' }))
  expect(await screen.findByRole('heading', { name: 'Agents' })).toBeDefined()
  expect(screen.getByRole('button', { name: 'Pause everyone' })).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
  expect(await screen.findByRole('heading', { name: 'Settings' })).toBeDefined()
  expect(await screen.findByRole('heading', { name: 'Usage' })).toBeDefined()

  fireEvent.click(screen.getByRole('button', { name: 'Search' }))
  const palette = await screen.findByRole('dialog', { name: 'Search and commands' })
  fireEvent.click(within(palette).getByRole('button', { name: 'Close search' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.keyDown(document, { key: 'k', ctrlKey: true })
  expect(await screen.findByRole('dialog', { name: 'Search and commands' })).toBeDefined()
})

test('Look choices apply to the whole bold shell', async () => {
  window.localStorage.setItem('score.theme', 'light')
  window.localStorage.setItem('score.textScale', '1.15')
  open('/b')
  const shell = document.querySelector<HTMLElement>('.bold-shell')!
  await waitFor(() => expect(shell.dataset.look).toBe('light'))
  expect(shell.style.getPropertyValue('--scale')).toBe('1.15')
})

test.each(['ctrlKey', 'metaKey'])(
  '%s+K does nothing while the palette is already open',
  async (modifier) => {
    vi.stubGlobal('requestAnimationFrame', (run: FrameRequestCallback) => {
      run(0)
      return 1
    })
    open('/b')
    const trigger = screen.getByRole('button', { name: 'Search' })
    trigger.focus()
    fireEvent.click(trigger)
    const palette = await screen.findByRole('dialog', { name: 'Search and commands' })
    fireEvent.keyDown(document, { key: 'k', [modifier]: true })
    expect(screen.getByRole('dialog', { name: 'Search and commands' })).toBeDefined()
    fireEvent.click(within(palette).getByRole('button', { name: 'Close search' }))
    await waitFor(() => expect(document.activeElement).toBe(trigger))
  },
)

test('the index opens the new shell', async () => {
  const bold = open('/')
  await waitFor(() => expect(bold.state.location.pathname).toBe('/b'))
})

test('the Terminal button shows only when the server offers a terminal, and Back returns', async () => {
  terminalFixture = { terminal: true, terminalUnavailable: null }
  const router = open('/b/agents')
  fireEvent.click(await screen.findByRole('button', { name: 'Terminal' }))
  await waitFor(() => expect(router.state.location.pathname).toBe('/b/terminal'))
  fireEvent.click(await screen.findByRole('button', { name: '← Back' }))
  await waitFor(() => expect(router.state.location.pathname).toBe('/b/agents'))
})

test('no Terminal button when the terminal is off or unavailable', async () => {
  terminalFixture = { terminal: true, terminalUnavailable: 'The terminal needs HTTPS.' }
  open('/b')
  await screen.findByRole('button', { name: 'Settings' })
  await new Promise((resolve) => setTimeout(resolve, 30))
  expect(screen.queryByRole('button', { name: 'Terminal' })).toBeNull()
  cleanup()
  terminalFixture = { terminal: false, terminalUnavailable: null }
  open('/b')
  await new Promise((resolve) => setTimeout(resolve, 30))
  expect(screen.queryByRole('button', { name: 'Terminal' })).toBeNull()
})

test('Ctrl+` opens the terminal and returns, but not while typing', async () => {
  terminalFixture = { terminal: true, terminalUnavailable: null }
  const router = open('/b/agents')
  await screen.findByRole('button', { name: 'Terminal' })
  const field = document.body.appendChild(document.createElement('input'))
  fireEvent.keyDown(field, { key: '`', ctrlKey: true })
  expect(router.state.location.pathname).toBe('/b/agents')
  field.remove()
  fireEvent.keyDown(document.body, { key: '`', ctrlKey: true })
  await waitFor(() => expect(router.state.location.pathname).toBe('/b/terminal'))
  fireEvent.keyDown(document.body, { key: '`', metaKey: true })
  await waitFor(() => expect(router.state.location.pathname).toBe('/b/agents'))
})

test('the shell mounts the notification bridge and the update banner', async () => {
  open('/b')
  expect(await screen.findByTestId('notification-bridge')).toBeDefined()
  expect(screen.getByTestId('update-banner')).toBeDefined()
})

// 3.22.0 replacements for the shell tests the Library/Runs/Thread modes took with them. Each says what it replaces.

// was: 'the side-panel dropdown is a disclosure that closes and restores focus'
test('the side panel is a lone Info tab (Graph joins it on a run), not a dropdown of modes', () => {
  open('/b')
  const tabs = screen.getByRole('tablist', { name: 'Panel' })
  const info = within(tabs).getByRole('tab', { name: 'Info' })
  expect(within(tabs).getAllByRole('tab')).toHaveLength(1)
  expect(info.getAttribute('aria-selected')).toBe('true')
  // Results folded into Info (3.25.0); Thread, Runs and Library are not modes of the panel either.
  for (const gone of ['Results', 'Thread', 'Runs', 'Library'])
    expect(within(tabs).queryByRole('tab', { name: gone })).toBeNull()
  expect(screen.queryByRole('navigation', { name: 'How to see the work' })).toBeNull()
  expect(screen.queryByRole('button', { name: /^Library/ })).toBeNull()
  // The files and results are a section of Info.
  expect(screen.getByRole('heading', { name: 'Files and results' })).toBeDefined()
})

// was: 'opening the same run again after the phone sheet was closed opens the sheet again'
test('an old ?run= address lands on the Recipes page’s run every time, even the same one again', async () => {
  phone = true
  const router = open('/b?run=brief-x')
  await waitFor(() => expect(router.state.location.pathname).toBe('/b/settings/recipes'))
  expect(router.state.location.search).toBe('?run=brief-x')
  await act(async () => {
    await router.navigate('/b')
  })
  await act(async () => {
    await router.navigate('/b?run=brief-x')
  })
  await waitFor(() => expect(router.state.location.pathname).toBe('/b/settings/recipes'))
  expect(router.state.location.search).toBe('?run=brief-x')
  // The side sheet is not what opens for a run any more.
  expect(screen.queryByRole('complementary', { name: 'Side panel' })).toBeNull()
})

// was: 'an in-place edit of the address (a replace) does not reopen a run the person closed'
test('an in-place edit of the address (a replace) does not reopen a sheet the person closed', async () => {
  phone = true
  const router = open('/b?open=1&work=results')
  fireEvent.click(screen.getByRole('button', { name: 'Chat info' }))
  await screen.findByRole('complementary', { name: 'Side panel' })
  // Chat info opens the sheet on Info (`?work=results` is Info at Files and results), then the person closes it.
  fireEvent.click(screen.getByRole('button', { name: 'Close side panel' }))
  expect(screen.queryByRole('complementary', { name: 'Side panel' })).toBeNull()
  await act(async () => {
    await router.navigate('/b?open=1&work=results&ref=other', { replace: true })
  })
  expect(screen.queryByRole('complementary', { name: 'Side panel' })).toBeNull()
})

// was: 'Escape in a Library dialog closes the dialog, not the phone sheet'
test('Escape inside a dialog in the phone sheet is the dialog’s, and Escape on the sheet itself closes it', async () => {
  phone = true
  open('/b?open=1')
  fireEvent.click(screen.getByRole('button', { name: 'Chat info' }))
  const panel = await screen.findByRole('complementary', { name: 'Side panel' })
  const dialog = document.createElement('div')
  dialog.setAttribute('role', 'dialog')
  const field = document.createElement('input')
  dialog.append(field)
  panel.append(dialog)
  try {
    fireEvent.keyDown(field, { key: 'Escape' })
    expect(screen.getByRole('complementary', { name: 'Side panel' })).toBeDefined()
  } finally {
    dialog.remove()
  }
  fireEvent.keyDown(screen.getByRole('tab', { name: 'Info' }), { key: 'Escape' })
  await waitFor(() =>
    expect(screen.queryByRole('complementary', { name: 'Side panel' })).toBeNull(),
  )
})

// was: 'the Results view keeps its element while the phone sheet closes and the tab changes'
test('the Files and results section keeps its element while the phone sheet closes and opens', async () => {
  phone = true
  open('/b?open=1&work=results')
  fireEvent.click(screen.getByRole('button', { name: 'Chat info' }))
  const files = await screen.findByTestId('files-results')
  expect(screen.getByRole('tab', { name: 'Info' }).getAttribute('aria-selected')).toBe('true')

  fireEvent.click(screen.getByRole('button', { name: 'Close side panel' }))
  expect(screen.getByTestId('files-results')).toBe(files)
  fireEvent.click(screen.getByRole('button', { name: 'Chat info' }))
  expect(screen.getByTestId('files-results')).toBe(files)
})

// was: 'a Library note request is consumed and can be repeated after another mode'
test('?note= and ?library=1 open Knowledge instead, and can be repeated', async () => {
  const router = open('/b?note=Decisions%2FSource.md')
  await waitFor(() => expect(router.state.location.pathname).toBe('/b/knowledge'))
  expect(router.state.location.search).toBe('?note=Decisions%2FSource.md')
  expect(await screen.findByLabelText('Contents of Decisions/Source.md')).toBeDefined()

  await act(async () => {
    await router.navigate('/b')
  })
  await act(async () => {
    await router.navigate('/b?note=Decisions%2FSource.md')
  })
  await waitFor(() => expect(router.state.location.pathname).toBe('/b/knowledge'))
  expect(router.state.location.search).toBe('?note=Decisions%2FSource.md')

  await act(async () => {
    await router.navigate('/b')
  })
  await act(async () => {
    await router.navigate('/b?library=1')
  })
  await waitFor(() => expect(router.state.location.pathname).toBe('/b/knowledge'))
  expect(router.state.location.search).toBe('')
})

test('/runs/:id opens the run on the Recipes page, keeping other parameters', async () => {
  const router = open('/runs/brief-x?from=search')
  await waitFor(() => expect(router.state.location.pathname).toBe('/b/settings/recipes'))
  expect(new URLSearchParams(router.state.location.search).get('run')).toBe('brief-x')
  expect(new URLSearchParams(router.state.location.search).get('from')).toBe('search')
})

// was: 'a removed agent leaves the dock and the side panel’s one-to-ones; one setting up stays in the dock only'
test('a removed agent leaves the dock and the Direct list; one setting up stays in the dock only', async () => {
  const base = agents[1]!
  extraAgents = [
    {
      ...base,
      id: 'gone',
      name: 'gone',
      lifecycle: {
        state: 'removed',
        incarnationId: '00000000-0000-4000-8000-000000000001',
        operationId: null,
      },
    },
    {
      ...base,
      id: 'fresh',
      name: 'fresh',
      lifecycle: {
        state: 'setting_up',
        incarnationId: '00000000-0000-4000-8000-000000000002',
        operationId: '00000000-0000-4000-8000-000000000003',
      },
    },
  ]
  open('/b')
  const dock = screen.getByRole('group', { name: /Your team/ })
  await within(dock).findByRole('button', { name: /^One to one with fresh, / })
  expect(within(dock).queryByRole('button', { name: /^One to one with gone, / })).toBeNull()
  const chats = await screen.findByRole('complementary', { name: 'Chats' })
  const direct = within(within(chats).getByRole('heading', { name: 'Direct' }).parentElement!)
  await direct.findByRole('link', { name: /builder/ })
  expect(direct.queryByRole('link', { name: /gone/ })).toBeNull()
  expect(direct.queryByRole('link', { name: /fresh/ })).toBeNull()
})

// New (3.22.0 item 11): the phone top bar fits one row with the terminal button on.
test('the phone top bar keeps wordmark, section pills, terminal button and avatar in one row', async () => {
  phone = true
  terminalFixture = { terminal: true, terminalUnavailable: null }
  open('/b')
  const terminal = await screen.findByRole('button', { name: 'Terminal' })
  const bar = screen.getByRole('banner')
  const mark = within(bar).getByRole('button', { name: 'Score, go to the team room' })
  const avatar = within(bar).getByText('Y')
  const links = bar.querySelector('.bold-top-links') as HTMLElement
  for (const name of ['Tasks', 'Screens'])
    expect(within(links).getByRole('button', { name })).toBeDefined()
  // 3.27.0: Recipes moved into Settings.
  expect(within(links).queryByRole('button', { name: 'Recipes' })).toBeNull()
  // All four parts are direct children of the one bar, in reading order, and nothing else is on a phone's bar.
  const parts = [...bar.children]
  expect(parts).toEqual([mark, links, terminal, avatar])
  expect(terminal.classList.contains('sm')).toBe(true)

  // jsdom has no layout, so the rules that keep it on one row are read from the stylesheet: the bar never wraps on a
  // phone, the pills take only the room that is left and scroll, and the other three parts never shrink.
  const css = readFileSync(`${__dirname}/bold-topbar.css`, 'utf8')
  const phoneRules = readFileSync(`${__dirname}/bold-responsive.css`, 'utf8')
  expect(phoneRules).toMatch(/\.top \{[^}]*flex-wrap: nowrap/)
  expect(css).toMatch(/\.bold-top-links \{[^}]*flex: 1 1 0;[^}]*overflow-x: auto/)
  const chatsCss = readFileSync(`${__dirname}/chats/chats.css`, 'utf8')
  expect(chatsCss).toMatch(
    /\.top \.word,\s*\[data-ui='bold'\] \.bold-avatar,\s*\[data-ui='bold'\] \.bold-terminal-btn \{\s*flex-shrink: 0/,
  )
})

// 3.23.0: a topic that holds a run shows its card, a Graph tab and the graph; `?run=` lands there.
const runTopic = {
  id: 'job-run',
  title: 'Review and ship',
  state: 'working' as const,
  isDefault: false,
  recipe: { kind: 'orchestration' as const, ref: 'orch-1' },
}
const runSummary = {
  id: 'orch-1',
  title: 'Review and ship',
  status: 'running',
  pauseReason: null,
  leadAgentId: 'lead',
  roomId: 'team-room',
  briefId: 'brief-1',
  gatePolicy: 'lead-asks',
  revision: 1,
  ownership: 'owned',
  steps: { total: 4, active: 1, succeeded: 2, failed: 0 },
  leadTurnsUsed: 1,
  maxLeadTurns: 8,
  needsYou: [],
  createdAt: '2026-10-24T09:00:00.000Z',
  updatedAt: '2026-10-24T10:00:00.000Z',
  endedAt: null,
}
const fullTopic = (job: typeof runTopic) => ({
  roomId: 'team-room',
  holderAgentId: 'lead',
  exchangeBudget: 8,
  jobTurnLimit: 40,
  unread: 0,
  activeAgents: [],
  lastMessageAt: null,
  messageCount: 0,
  summary: null,
  source: null,
  reportBack: null,
  spendCapUsd: null,
  createdAt: '2026-10-24T09:00:00.000Z',
  updatedAt: '2026-10-24T09:00:00.000Z',
  ...job,
})

test('a topic that holds a run shows the run card after its divider, and Show graph opens the Graph tab', async () => {
  runSummaries = [runSummary]
  runJobs = [fullTopic(runTopic)]
  open('/b', [runTopic])
  const card = await screen.findByRole('region', { name: 'Run: Review and ship' })
  expect(await within(card).findByText('step 3 of 4')).toBeDefined()
  expect(within(card).getByRole('progressbar', { name: 'Steps done' })).toBeDefined()
  const tabs = screen.getByRole('tablist', { name: 'Panel' })
  expect(within(tabs).getByRole('tab', { name: 'Graph' }).getAttribute('aria-selected')).toBe(
    'false',
  )
  fireEvent.click(within(card).getByRole('button', { name: 'Show graph' }))
  expect(within(tabs).getByRole('tab', { name: 'Graph' }).getAttribute('aria-selected')).toBe(
    'true',
  )
  expect(await screen.findByLabelText('Graph of Review and ship')).toBeDefined()
  expect(
    screen.getByText('Run · Review and ship', { selector: '.bold-topic-graph-head span' }),
  ).toBeDefined()
  // 3.29.0: what only the old run page showed is folded under the log, and the Graph tab has no link to a run page.
  expect(
    within(screen.getByLabelText('Graph of Review and ship')).getByText('Run details'),
  ).toBeDefined()
  expect(
    within(screen.getByLabelText('Graph of Review and ship')).queryByRole('link', {
      name: 'Open the run',
    }),
  ).toBeNull()
  // Back to Info and the graph leaves.
  fireEvent.click(within(tabs).getByRole('tab', { name: 'Info' }))
  expect(screen.queryByLabelText('Graph of Review and ship')).toBeNull()
})

const detailCalls = () =>
  (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
    .map((call) => new URL(String(call[0]), 'http://x').pathname)
    .filter((path) => path === '/api/orchestrations/orch-1')

test('a finished run’s card reads the summary only and fetches no run detail', async () => {
  runSummaries = [{ ...runSummary, status: 'succeeded', endedAt: '2026-10-24T10:30:00.000Z' }]
  runJobs = [fullTopic(runTopic)]
  open('/b', [runTopic])
  const card = await screen.findByRole('region', { name: 'Run: Review and ship' })
  expect(await within(card).findByText('2 of 4 steps done')).toBeDefined()
  expect(detailCalls()).toEqual([])
})

test('a run that is still going reads its detail for the who-is-on-what line', async () => {
  runSummaries = [runSummary]
  runJobs = [fullTopic(runTopic)]
  open('/b', [runTopic])
  await screen.findByRole('region', { name: 'Run: Review and ship' })
  await waitFor(() => expect(detailCalls().length).toBeGreaterThan(0))
})

test('a run that needs you shows a protected waiting line on its card', async () => {
  runSummaries = [
    { ...runSummary, needsYou: [{ kind: 'gate', gateId: 'gate-1', stepId: 'step-1' }] },
  ]
  runJobs = [fullTopic(runTopic)]
  open('/b', [runTopic])
  const card = await screen.findByRole('region', { name: 'Run: Review and ship' })
  const line = (await within(card).findByText(/This run is waiting for you/)).closest(
    '[data-protected]',
  )
  expect(line?.getAttribute('data-protected')).toBe('block')
})

const plainTopic = {
  id: 'job-plain',
  title: 'Plain',
  state: 'working' as const,
  isDefault: false,
}

test('moving to a topic without a run resets the panel to Info, so Graph does not come back by itself', async () => {
  runSummaries = [runSummary]
  runJobs = [
    fullTopic(runTopic),
    { ...fullTopic(plainTopic as unknown as typeof runTopic), recipe: null },
  ]
  const router = open('/b?job=job-run&work=graph', [runTopic, plainTopic])
  const tabs = screen.getByRole('tablist', { name: 'Panel' })
  await waitFor(() =>
    expect(within(tabs).getByRole('tab', { name: 'Graph' }).getAttribute('aria-selected')).toBe(
      'true',
    ),
  )
  await act(async () => {
    await router.navigate('/b?job=job-plain')
  })
  await waitFor(() => expect(within(tabs).queryByRole('tab', { name: 'Graph' })).toBeNull())
  expect(within(tabs).getByRole('tab', { name: 'Info' }).getAttribute('aria-selected')).toBe('true')
  await act(async () => {
    await router.navigate('/b?job=job-run')
  })
  const graphTab = await within(tabs).findByRole('tab', { name: 'Graph' })
  expect(graphTab.getAttribute('aria-selected')).toBe('false')
  expect(screen.queryByLabelText('Graph of Review and ship')).toBeNull()
})

test('under 1280px the chat list folds to its rail while Graph is open', async () => {
  narrow = true
  runSummaries = [runSummary]
  runJobs = [fullTopic(runTopic)]
  open('/b?job=job-run&work=graph', [runTopic])
  expect(await screen.findByRole('complementary', { name: 'Chats, folded' })).toBeDefined()
  expect(screen.queryByRole('button', { name: 'Show the chat list' })).toBeNull()
  const tabs = screen.getByRole('tablist', { name: 'Panel' })
  fireEvent.click(within(tabs).getByRole('tab', { name: 'Info' }))
  expect(await screen.findByRole('complementary', { name: 'Chats' })).toBeDefined()
})

test('from 1280px the chat list stays open beside the Graph tab', async () => {
  runSummaries = [runSummary]
  runJobs = [fullTopic(runTopic)]
  open('/b?job=job-run&work=graph', [runTopic])
  expect(await screen.findByLabelText('Graph of Review and ship')).toBeDefined()
  expect(screen.getByRole('complementary', { name: 'Chats' })).toBeDefined()
})

test('on a phone ?work=graph opens the side sheet on its Graph tab', async () => {
  phone = true
  runSummaries = [runSummary]
  runJobs = [fullTopic(runTopic)]
  open('/b?job=job-run&work=graph', [runTopic])
  const panel = await screen.findByRole('complementary', { name: 'Side panel' })
  await waitFor(() => expect(panel.getAttribute('aria-modal')).toBe('true'))
  expect(await within(panel).findByLabelText('Graph of Review and ship')).toBeDefined()
})

test('there is no Graph tab when the current topic holds no run', async () => {
  open('/b', [{ id: 'job-plain', title: 'Plain', state: 'working', isDefault: false }])
  const tabs = screen.getByRole('tablist', { name: 'Panel' })
  expect(within(tabs).queryByRole('tab', { name: 'Graph' })).toBeNull()
})

test('?work=graph opens the Graph tab on the topic’s run', async () => {
  runSummaries = [runSummary]
  runJobs = [fullTopic(runTopic)]
  open('/b?job=job-run&work=graph', [runTopic])
  const tabs = screen.getByRole('tablist', { name: 'Panel' })
  await waitFor(() =>
    expect(within(tabs).getByRole('tab', { name: 'Graph' }).getAttribute('aria-selected')).toBe(
      'true',
    ),
  )
  expect(await screen.findByLabelText('Graph of Review and ship')).toBeDefined()
})

test('?run=<id> lands on the chat and topic with the Graph tab open', async () => {
  runSummaries = [runSummary]
  runJobs = [fullTopic(runTopic)]
  const router = open('/b?run=orch-1', [runTopic])
  await waitFor(() => expect(router.state.location.search).toContain('work=graph'))
  expect(router.state.location.search).toContain('job=job-run')
  expect(router.state.location.pathname).toBe('/b')
  const tabs = screen.getByRole('tablist', { name: 'Panel' })
  await waitFor(() =>
    expect(within(tabs).getByRole('tab', { name: 'Graph' }).getAttribute('aria-selected')).toBe(
      'true',
    ),
  )
})

// 3.25.0: Results folded into Info (DECISIONS 161): the Files and results section and the viewer sheet.
const madeAt = (minute: number) => `2026-10-24T10:${String(minute).padStart(2, '0')}:00.000Z`
const filesResults = (count: number) => ({
  asOfSeq: 2,
  items: [
    {
      kind: 'change',
      id: 'change:job-plain',
      title: 'Plain',
      authors: ['builder'],
      state: 'working',
      whatChanged: [],
      files: Array.from({ length: count }, (_, index) => ({
        path: `api/file-${index + 1}.py`,
        added: 1,
        removed: 0,
        by: ['builder'],
      })),
      at: madeAt(10),
    },
    {
      kind: 'draft',
      id: 'draft-notes',
      agentId: 'designer',
      title: 'Release notes',
      target: { kind: 'workspace', path: 'docs/notes.md' },
      at: madeAt(20),
    },
  ],
  screens: [
    {
      agentId: 'builder',
      seq: 3,
      surface: 'terminal',
      caption: 'Ran the tests',
      live: false,
      at: madeAt(30),
    },
  ],
})
const filesWorkbench = {
  asOfSeq: 2,
  files: [
    {
      path: 'api/file-1.py',
      language: 'python',
      exact: false,
      lines: [{ n: 1, text: 'PAGE_SIZE = 50', by: 'builder' }],
      cursors: [],
      comments: [],
      editedBy: ['builder'],
      lastEditAt: madeAt(10),
    },
  ],
  looseComments: [],
  drafts: [
    {
      kind: 'draft',
      id: 'draft-notes',
      agentId: 'designer',
      title: 'Release notes',
      target: { kind: 'workspace', path: 'docs/notes.md' },
      at: madeAt(20),
    },
  ],
  screens: [],
}
const openWithFiles = (path: string, count = 2) => {
  resultsFixture = filesResults(count)
  workbenchFixture = filesWorkbench
  runJobs = [{ ...fullTopic(plainTopic as unknown as typeof runTopic), recipe: null }]
  return open(path, [plainTopic])
}

test('Info lists what the current topic made: icon, name, who made it, newest first', async () => {
  openWithFiles('/b?job=job-plain')
  const section = await screen.findByTestId('files-results')
  const rows = await within(section).findAllByRole('link')
  expect(rows.map((row) => row.getAttribute('data-files-row'))).toEqual([
    'screen:builder',
    'draft:draft-notes',
    'code:api/file-1.py',
    'code:api/file-2.py',
  ])
  expect(rows[0]!.textContent).toContain('builder’s screen')
  expect(rows[1]!.textContent).toContain('Release notes')
  expect(rows[1]!.textContent).toContain('designer')
  expect(rows[2]!.textContent).toContain('file-1.py')
  expect(rows[2]!.textContent).toContain('builder')
  expect(within(section).queryByRole('button', { name: /Show all/ })).toBeNull()
})

test('Info says so quietly when nothing was made in the job', async () => {
  runJobs = [{ ...fullTopic(plainTopic as unknown as typeof runTopic), recipe: null }]
  open('/b?job=job-plain', [plainTopic])
  const section = await screen.findByTestId('files-results')
  expect(await within(section).findByText('Nothing made in this job yet')).toBeDefined()
  expect(within(section).queryByRole('link')).toBeNull()
})

test('more than six rows fold behind Show all (N)', async () => {
  openWithFiles('/b?job=job-plain', 8)
  const section = await screen.findByTestId('files-results')
  await within(section).findAllByRole('link')
  expect(within(section).getAllByRole('link')).toHaveLength(6)
  fireEvent.click(within(section).getByRole('button', { name: 'Show all (10)' }))
  expect(within(section).getAllByRole('link')).toHaveLength(10)
  fireEvent.click(within(section).getByRole('button', { name: 'Show fewer' }))
  expect(within(section).getAllByRole('link')).toHaveLength(6)
})

test('the conversation under the viewer sheet is inert, and a waiting card is cued on the sheet', async () => {
  const router = openWithFiles('/b?job=job-plain')
  const section = await screen.findByTestId('files-results')
  fireEvent.click(await within(section).findByRole('link', { name: /Release notes/ }))
  const sheet = await screen.findByRole('dialog', { name: 'Workbench viewer' })
  const column = sheet.closest('.roomcol')!
  const under = [...column.children].filter((child) => child !== sheet)
  expect(under.length).toBeGreaterThan(0)
  for (const child of under) expect(child.hasAttribute('inert')).toBe(true)
  expect(sheet.hasAttribute('inert')).toBe(false)
  // The title is not a .bold-chat-kicker, which a phone hides visually.
  const title = within(sheet).getByRole('heading', { name: 'Files and results' })
  expect(title.className).toBe('bold-viewer-title')
  // No card waits: no cue.
  expect(within(sheet).queryByText(/need.* you/)).toBeNull()

  // A needs-you card appears in the conversation under the sheet.
  const stream = document.getElementById('bold-room-stream')!
  const card = document.createElement('div')
  card.setAttribute('data-pin-key', 'approval:a1')
  card.tabIndex = -1
  card.getBoundingClientRect = () => ({ top: 10, bottom: 60, height: 50 }) as DOMRect
  stream.appendChild(card)
  const cue = await within(sheet).findByRole('button', { name: '1 needs you · Back to the chat' })
  expect(cue.getAttribute('data-protected')).not.toBeNull()
  fireEvent.click(cue)
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Workbench viewer' })).toBeNull())
  expect(router.state.location.search).not.toContain('work=')
  for (const child of under) expect(child.hasAttribute('inert')).toBe(false)
  await waitFor(() => expect(document.activeElement).toBe(card))
})

test('on a phone the cue also closes the Info sheet, so the card it goes to is not covered', async () => {
  phone = true
  openWithFiles('/b?job=job-plain')
  fireEvent.click(await screen.findByRole('button', { name: 'Chat info' }))
  const panel = await screen.findByRole('complementary', { name: 'Side panel' })
  fireEvent.click(await within(panel).findByRole('link', { name: /Release notes/ }))
  const sheet = await screen.findByRole('dialog', { name: 'Workbench viewer' })
  const stream = document.getElementById('bold-room-stream')!
  const card = document.createElement('div')
  card.setAttribute('data-pin-key', 'approval:a1')
  card.tabIndex = -1
  card.getBoundingClientRect = () => ({ top: 10, bottom: 60, height: 50 }) as DOMRect
  stream.appendChild(card)
  fireEvent.click(
    await within(sheet).findByRole('button', { name: '1 needs you · Back to the chat' }),
  )
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Workbench viewer' })).toBeNull())
  await waitFor(() =>
    expect(screen.queryByRole('complementary', { name: 'Side panel' })).toBeNull(),
  )
  await waitFor(() => expect(document.activeElement).toBe(card))
})

test('a row opens the viewer sheet over the conversation; Escape and the close button return focus to the row', async () => {
  const router = openWithFiles('/b?job=job-plain')
  const section = await screen.findByTestId('files-results')
  const row = await within(section).findByRole('link', { name: /Release notes/ })
  row.focus()
  fireEvent.click(row)
  const sheet = await screen.findByRole('dialog', { name: 'Workbench viewer' })
  expect(router.state.location.search).toContain('work=draft')
  expect(router.state.location.search).toContain('job=job-plain')
  // The sheet sits in the conversation column; the side panel stays.
  expect(sheet.closest('.roomcol')).not.toBeNull()
  expect(screen.getByRole('complementary', { name: 'Side panel' })).toBeDefined()
  expect(await within(sheet).findByText('Release notes', { selector: 'h2' })).toBeDefined()
  expect(document.activeElement).toBe(
    within(sheet).getByRole('button', { name: 'Close the viewer' }),
  )

  fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Workbench viewer' })).toBeNull())
  expect(router.state.location.search).not.toContain('work=')
  await waitFor(() =>
    expect(document.activeElement?.getAttribute('data-files-row')).toBe('draft:draft-notes'),
  )

  fireEvent.click(screen.getByRole('link', { name: /Release notes/ }))
  fireEvent.click(await screen.findByRole('button', { name: 'Close the viewer' }))
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Workbench viewer' })).toBeNull())
  await waitFor(() =>
    expect(document.activeElement?.getAttribute('data-files-row')).toBe('draft:draft-notes'),
  )
})

test('on a phone the viewer is a full-screen sheet of its own', async () => {
  phone = true
  openWithFiles('/b?job=job-plain&work=draft')
  const sheet = await screen.findByRole('dialog', { name: 'Workbench viewer' })
  expect(sheet.className).toContain('phone')
  expect(sheet.closest('.roomcol')).toBeNull()
})

test('?work=draft and ?work=code&file= open the viewer on that item', async () => {
  openWithFiles('/b?job=job-plain&work=code&file=api%2Ffile-1.py')
  const sheet = await screen.findByRole('dialog', { name: 'Workbench viewer' })
  const fileTab = await within(sheet).findByRole('button', { name: 'api/file-1.py' })
  expect(fileTab.getAttribute('aria-pressed')).toBe('true')
  expect(sheet.textContent).toContain('PAGE_SIZE')
  // Nothing opened a dead tab: Info is the tab, there is no Results tab.
  const tabs = screen.getByRole('tablist', { name: 'Panel' })
  expect(within(tabs).getByRole('tab', { name: 'Info' }).getAttribute('aria-selected')).toBe('true')
  cleanup()
  disposers.splice(0).forEach((dispose) => dispose())
  openWithFiles('/b?job=job-plain&work=draft')
  const draft = await screen.findByRole('dialog', { name: 'Workbench viewer' })
  expect(await within(draft).findByText('Release notes', { selector: 'h2' })).toBeDefined()
})

test('?work=results opens Info at Files and results, with no viewer sheet', async () => {
  openWithFiles('/b?job=job-plain&work=results')
  await screen.findByTestId('files-results')
  expect(screen.queryByRole('dialog', { name: 'Workbench viewer' })).toBeNull()
  const tabs = screen.getByRole('tablist', { name: 'Panel' })
  expect(within(tabs).getByRole('tab', { name: 'Info' }).getAttribute('aria-selected')).toBe('true')
  expect(screen.getByRole('heading', { name: 'Files and results' })).toBeDefined()
})

test('a one-to-one has the same Files and results in its Info', async () => {
  resultsFixture = filesResults(1)
  workbenchFixture = filesWorkbench
  open('/b?with=builder&chat=chat-1')
  const section = await screen.findByTestId('files-results')
  expect(within(section).getByRole('heading', { name: 'Files and results' })).toBeDefined()
})
