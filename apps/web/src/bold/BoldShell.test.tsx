import type { AgentSummary } from '@score/contract'
import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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

class Source extends EventTarget {
  close() {}
}

class PendingUpload {
  static last: PendingUpload
  upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null }
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  status = 200
  responseText = ''
  responseType = ''
  headers: Record<string, string> = {}
  url = ''
  constructor() {
    PendingUpload.last = this
  }
  open(_method: string, url: string) {
    this.url = url
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name.toLowerCase()] = value
  }
  send() {}
}

let phone = false
let approvalFixture = false
let terminalFixture: { terminal: boolean; terminalUnavailable: string | null } | null = null
let teamRoomFixture: unknown = null
const disposers: (() => void)[] = []

beforeEach(() => {
  phone = false
  approvalFixture = false
  terminalFixture = null
  teamRoomFixture = null
  window.localStorage.clear()
  window.history.replaceState(null, '', '/')
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: query === '(max-width: 860px)' ? phone : false,
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
        return Promise.resolve(Response.json({ asOfSeq: 1, items: agents }))
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
      if (url.pathname === '/api/orchestrations')
        return Promise.resolve(Response.json({ asOfSeq: 1, items: [] }))
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
  if (approvalFixture) teamRoomFixture = teamRoom
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
  expect(screen.getByRole('button', { name: 'Team' })).toBeDefined()
  const roomTitle = screen.getByRole('button', { name: 'Team room' })
  expect(roomTitle.getAttribute('aria-haspopup')).toBe('listbox')
  expect(roomTitle.getAttribute('aria-expanded')).toBe('false')

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

test('the side-panel dropdown is a disclosure that closes and restores focus', () => {
  open('/b')
  const toggle = screen.getByRole('button', { name: 'Work' })
  fireEvent.click(toggle)
  expect(toggle.getAttribute('aria-expanded')).toBe('true')
  const menuId = toggle.getAttribute('aria-controls')
  expect(menuId).not.toBeNull()
  const menu = document.getElementById(menuId!)!
  expect(menu).not.toBeNull()
  expect(menu.querySelector('[role="listbox"], [role="option"]')).toBeNull()
  expect(within(menu).getByRole('button', { name: /^Work/ }).getAttribute('aria-current')).toBe(
    'true',
  )
  expect(
    within(menu)
      .getByRole('button', { name: /^Library/ })
      .hasAttribute('aria-current'),
  ).toBe(false)

  fireEvent.click(within(menu).getByRole('button', { name: /^Library/ }))
  expect(screen.getByTestId('bold-library')).toBeDefined()
  expect(document.getElementById(menuId!)).toBeNull()
  expect(document.activeElement).toBe(toggle)

  fireEvent.click(toggle)
  expect(document.getElementById(menuId!)).not.toBeNull()
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(document.getElementById(menuId!)).toBeNull()
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  expect(document.activeElement).toBe(toggle)
})

test('a phone keeps the wordmark and avatar, shows the tab bar and opens the side panel as a sheet', async () => {
  phone = true
  open('/b')
  const nav = screen.getByRole('navigation', { name: 'Main' })
  for (const label of ['Room', 'Team', 'Search', 'Settings'])
    expect(within(nav).getByRole('button', { name: label })).toBeDefined()
  expect(screen.queryByRole('complementary', { name: 'Side panel' })).toBeNull()
  expect(screen.queryByRole('group', { name: /Your team/ })).toBeNull()
  expect(screen.getByRole('button', { name: 'Score, go to the team room' })).toBeDefined()
  expect(screen.getByText('Y')).toBeDefined()
  const openPanel = screen.getByRole('button', { name: 'Open side panel' })
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
  const openPanelAgain = screen.getByRole('button', { name: 'Open side panel' })
  await waitFor(() => expect(document.activeElement).toBe(openPanelAgain))
})

test('opening the same run again after the phone sheet was closed opens the sheet again', async () => {
  phone = true
  const router = open('/b?run=brief-x')
  await screen.findByRole('complementary', { name: 'Side panel' })
  fireEvent.click(screen.getByRole('button', { name: 'Close side panel' }))
  expect(screen.queryByRole('complementary', { name: 'Side panel' })).toBeNull()
  await act(async () => {
    await router.navigate('/b?run=brief-x')
  })
  await screen.findByRole('complementary', { name: 'Side panel' })
})

test('an in-place edit of the address (a replace) does not reopen a run the person closed', async () => {
  phone = true
  const router = open('/b?run=brief-x')
  await screen.findByRole('complementary', { name: 'Side panel' })
  fireEvent.click(screen.getByRole('button', { name: 'Close side panel' }))
  await act(async () => {
    await router.navigate('/b?run=brief-x&ref=other', { replace: true })
  })
  expect(screen.queryByRole('complementary', { name: 'Side panel' })).toBeNull()
})

test('the phone Room badge waits for the team room and counts the job in the URL', async () => {
  phone = true
  approvalFixture = true
  open('/b?job=job-notes', [
    { id: 'job-default', title: 'Team room', state: 'working', isDefault: true },
    { id: 'job-notes', title: 'Release notes', state: 'waiting_on_you', isDefault: false },
  ])
  const nav = screen.getByRole('navigation', { name: 'Main' })
  const room = within(nav).getByRole('button', { name: /^Room/ })
  // The cached team-room read is already successful in this harness; the selected job has one approval to answer.
  await waitFor(() => expect(room.getAttribute('aria-label')).toBe('Room, 1 need you'))
  const badge = room.querySelector('.bold-tab-count')
  expect(badge?.textContent).toBe('1')
  expect(badge?.getAttribute('data-protected')).toBe('inline-flex')
})

test('Escape in a Library dialog closes the dialog, not the phone sheet', async () => {
  phone = true
  open('/b')
  fireEvent.click(screen.getByRole('button', { name: 'Open side panel' }))
  fireEvent.click(screen.getByRole('button', { name: /^Work/ }))
  fireEvent.click(screen.getByRole('button', { name: /^Library/ }))
  fireEvent.click(screen.getByRole('button', { name: 'New note' }))
  const dialog = screen.getByRole('dialog', { name: 'New note' })
  fireEvent.keyDown(within(dialog).getByLabelText('Path in Knowledge'), { key: 'Escape' })
  expect(screen.queryByRole('dialog', { name: 'New note' })).toBeNull()
  expect(screen.getByRole('complementary', { name: 'Side panel' })).toBeDefined()
  expect(screen.getByTestId('bold-library')).toBeDefined()
})

test('the Library keeps an upload and its state while the phone sheet closes and the mode changes', async () => {
  phone = true
  vi.stubGlobal('XMLHttpRequest', PendingUpload)
  open('/b')
  fireEvent.click(screen.getByRole('button', { name: 'Open side panel' }))
  fireEvent.click(screen.getByRole('button', { name: /^Work/ }))
  fireEvent.click(screen.getByRole('button', { name: /^Library/ }))
  const library = screen.getByTestId('bold-library')
  fireEvent.change(screen.getByPlaceholderText('Search'), { target: { value: 'still here' } })
  fireEvent.change(screen.getByLabelText('Choose files to upload to the Library'), {
    target: { files: [new File(['keep me'], 'notes.pdf', { type: 'application/pdf' })] },
  })
  await screen.findByRole('button', { name: /Uploading…/ })
  expect(PendingUpload.last.url).toBe('/api/knowledge/files/notes.pdf?onConflict=ask')

  fireEvent.click(screen.getByRole('button', { name: /^Library/ }))
  fireEvent.click(screen.getByRole('button', { name: /^Work/ }))
  expect(screen.getByTestId('bold-library')).toBe(library)
  expect(library.hasAttribute('hidden')).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: /^Work/ }))
  fireEvent.click(screen.getByRole('button', { name: /^Library/ }))
  expect(library.hasAttribute('hidden')).toBe(false)
  expect(screen.getByPlaceholderText('Search')).toHaveProperty('value', 'still here')
  expect(screen.getByRole('button', { name: /Uploading…/ })).toBeDefined()

  fireEvent.click(screen.getByRole('button', { name: 'Close side panel' }))
  expect(screen.getByTestId('bold-library')).toBe(library)
  fireEvent.click(screen.getByRole('button', { name: 'Open side panel' }))
  expect(screen.getByTestId('bold-library')).toBe(library)
  expect(screen.getByRole('button', { name: /Uploading…/ })).toBeDefined()

  PendingUpload.last.responseText = JSON.stringify({
    path: 'notes.pdf',
    kind: 'document',
    replaced: false,
    history: 'committed',
  })
  act(() => PendingUpload.last.onload?.())
})

test('a Library note request is consumed and can be repeated after another mode', async () => {
  const router = open('/b?note=Decisions%2FSource.md')
  const library = await screen.findByTestId('bold-library')
  expect(await screen.findByLabelText('Contents of Decisions/Source.md')).toBeDefined()
  await waitFor(() => expect(router.state.location.search).not.toContain('note='))

  fireEvent.click(screen.getByRole('button', { name: /^Library/ }))
  fireEvent.click(screen.getByRole('button', { name: /^Work/ }))
  expect(screen.getByTestId('bold-library')).toBe(library)
  expect(library.hasAttribute('hidden')).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: /^Work/ }))
  fireEvent.click(screen.getByRole('button', { name: /^Library/ }))
  expect(screen.getByLabelText('Contents of Decisions/Source.md')).toBeDefined()
})

test('Team and Settings are real pages, and the search button and Ctrl+K open the palette', async () => {
  open('/b')
  fireEvent.click(screen.getByRole('button', { name: 'Team' }))
  expect(await screen.findByRole('heading', { name: 'Your team' })).toBeDefined()
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

test('Settings offers the way back to the classic view', async () => {
  const router = open('/b/settings')
  expect(await screen.findByRole('heading', { name: 'Settings' })).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: 'Use the classic view' }))
  await waitFor(() => expect(router.state.location.pathname).toBe('/chat'))
  expect(window.localStorage.getItem('score.ui')).toBe('classic')
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

test('the index follows the per-device choice and ?ui= sets it', async () => {
  const bold = open('/?ui=bold')
  await waitFor(() => expect(bold.state.location.pathname).toBe('/b'))
  expect(window.localStorage.getItem('score.ui')).toBeNull()
})

test('the index opens the bold shell even after choosing classic', async () => {
  window.localStorage.setItem('score.ui', 'classic')
  const classic = open('/?ui=classic')
  await waitFor(() => expect(classic.state.location.pathname).toBe('/b'))
  expect(window.localStorage.getItem('score.ui')).toBe('classic')
})

test('the Terminal button shows only when the server offers a terminal, and Back returns', async () => {
  terminalFixture = { terminal: true, terminalUnavailable: null }
  const router = open('/b/team')
  fireEvent.click(await screen.findByRole('button', { name: 'Terminal' }))
  await waitFor(() => expect(router.state.location.pathname).toBe('/b/terminal'))
  fireEvent.click(await screen.findByRole('button', { name: '← Back' }))
  await waitFor(() => expect(router.state.location.pathname).toBe('/b/team'))
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
  const router = open('/b/team')
  await screen.findByRole('button', { name: 'Terminal' })
  const field = document.body.appendChild(document.createElement('input'))
  fireEvent.keyDown(field, { key: '`', ctrlKey: true })
  expect(router.state.location.pathname).toBe('/b/team')
  field.remove()
  fireEvent.keyDown(document.body, { key: '`', ctrlKey: true })
  await waitFor(() => expect(router.state.location.pathname).toBe('/b/terminal'))
  fireEvent.keyDown(document.body, { key: '`', metaKey: true })
  await waitFor(() => expect(router.state.location.pathname).toBe('/b/team'))
})
