import type { AgentSummary, Approval, Job, Message, WatchFrame, WatchMarker } from '@score/contract'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, expect, test, vi } from 'vitest'
import { BoldScreenView } from './BoldScreen.tsx'

const builder: AgentSummary = {
  id: 'builder',
  name: 'builder',
  role: 'Builds features',
  style: { color: '#19C39A', shape: 'triangle' },
  status: 'working',
  activity: 'Waiting for your OK',
  model: { id: 'fake-model', label: 'Demo model' },
  served: true,
}

const frames: WatchFrame[] = [
  {
    seq: 1,
    at: '2026-10-24T09:08:00.000Z',
    agentId: 'builder',
    runId: 'run-1',
    surface: 'terminal',
    terminal: { cwd: '~/app', command: 'ls', output: 'api  tests', status: 'ok' },
    caption: 'Listed the files',
  },
  {
    seq: 2,
    at: '2026-10-24T09:14:00.000Z',
    agentId: 'builder',
    runId: 'run-1',
    surface: 'browser',
    browser: { url: 'http://localhost:5173/feed', title: 'Activity feed', imageUrl: null },
    caption: 'Opened the activity feed',
  },
  {
    seq: 3,
    at: '2026-10-24T09:16:00.000Z',
    agentId: 'builder',
    runId: 'run-1',
    surface: 'terminal',
    terminal: {
      cwd: '~/app',
      command: 'pnpm test api/events',
      output: 'ok  keeps same-millisecond events',
      status: 'running',
    },
    caption: 'Ran pnpm test api/events',
  },
]

const markers: WatchMarker[] = [
  { seq: 1, at: '2026-10-24T09:08:00.000Z', kind: 'command' },
  { seq: 2, at: '2026-10-24T09:14:00.000Z', kind: 'browser' },
  { seq: 3, at: '2026-10-24T09:16:00.000Z', kind: 'command' },
]

const approval: Approval = {
  id: 'approval-ws',
  origin: 'score-run',
  phase: 'human_pending',
  status: 'pending',
  actionable: true,
  linkedTo: null,
  agentId: 'builder',
  title: 'May I install a package?',
  command: 'npm install ws@8',
  cwd: '~/app',
  description: 'The websocket feed needs it.',
  choices: ['once', 'deny'],
  createdAt: '2026-10-24T09:17:00.000Z',
  expiresAt: null,
  decision: null,
  delivery: 'none',
  blocking: 'Only this command is waiting.',
  refs: [],
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function renderScreen(approvals: Approval[] = [approval]) {
  render(
    <MemoryRouter>
      <BoldScreenView agent={builder} frames={frames} markers={markers} approvals={approvals} />
    </MemoryRouter>,
  )
}

test('shows the plain-step log, live screen, markers and the protected approval bar', () => {
  renderScreen()
  expect(screen.getByRole('heading', { name: 'builder’s screen' })).toBeDefined()
  const log = screen.getByRole('region', { name: 'What builder did' })
  expect(within(log).getByRole('button', { name: /Ran pnpm test api\/events/ })).toBeDefined()
  expect(within(log).getByRole('button', { name: /Opened the activity feed/ })).toBeDefined()

  expect(screen.getByText('Live', { selector: '.bold-screen-badge' })).toBeDefined()
  expect(screen.getByText('Read-only')).toBeDefined()
  expect(screen.getByText('pnpm test api/events')).toBeDefined()
  expect(screen.getByRole('group', { name: 'Replay timeline' })).toBeDefined()
  expect(screen.getByText('File edit')).toBeDefined()
  expect(screen.getByRole('button', { name: 'Back to live' }).getAttribute('aria-pressed')).toBe(
    'true',
  )

  const bar = screen.getByRole('group', { name: 'Approval needed' })
  expect(bar.getAttribute('data-protected')).toBe('flex')
  expect(bar.textContent).toContain('npm install ws@8')
  expect(within(bar).getByRole('button', { name: 'Approve' })).toBeDefined()
  expect(within(bar).getByRole('button', { name: 'Deny' })).toBeDefined()
  expect(screen.getByRole('link', { name: 'Open in terminal' }).getAttribute('href')).toBe(
    '/terminal',
  )
  expect(screen.queryByRole('textbox')).toBeNull()
  expect(document.querySelector('input, textarea, [contenteditable="true"]')).toBeNull()
})

test('a step takes the replay back, and an approval is never answered from the past', () => {
  renderScreen()
  fireEvent.click(screen.getByRole('button', { name: /Opened the activity feed/ }))
  expect(screen.getByText(/^Replaying /)).toBeDefined()
  expect(screen.getByRole('button', { name: 'Back to live' }).getAttribute('aria-pressed')).toBe(
    'false',
  )
  expect(screen.queryByRole('group', { name: 'Approval needed' })).toBeNull()
  expect(screen.getByText('Read-only')).toBeDefined()
})

test('a replay hands an open approval back to live through a protected chip', () => {
  renderScreen()
  fireEvent.click(screen.getByRole('button', { name: /Opened the activity feed/ }))
  const chip = screen.getByRole('button', { name: 'Needs you — go live' })
  expect(chip.getAttribute('data-protected')).toBe('inline-flex')
  fireEvent.click(chip)
  expect(screen.getByRole('group', { name: 'Approval needed' })).toBeDefined()
  expect(screen.queryByRole('button', { name: 'Needs you — go live' })).toBeNull()
})

test('the approval bar sends the same decision as the classic Watch card', async () => {
  const answered: Approval = {
    ...approval,
    status: 'approved',
    phase: 'decided',
    actionable: false,
    delivery: 'applied',
    decision: {
      choice: 'once',
      by: 'you',
      at: '2026-10-24T09:18:00.000Z',
    },
  }
  const fetchMock = vi.fn(async () => Response.json(answered))
  vi.stubGlobal('fetch', fetchMock)
  renderScreen()
  fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
  expect(await screen.findByText('Answer sent.')).toBeDefined()
  await waitFor(() => expect(fetchMock).toHaveBeenCalled())
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
  expect(url).toBe('/api/approvals/approval-ws/decision')
  expect(init.method).toBe('POST')
  expect(JSON.parse(String(init.body))).toEqual({ choice: 'once' })
})

test('a sending approval disables both answers and says Sending', () => {
  renderScreen([{ ...approval, delivery: 'delivering' }])
  const bar = screen.getByRole('group', { name: 'Approval needed' })
  expect(bar.textContent).toContain('Sending…')
  for (const button of within(bar).getAllByRole('button', { name: 'Sending…' }))
    expect(button).toHaveProperty('disabled', true)
  expect(within(bar).getAllByRole('button', { name: 'Sending…' })).toHaveLength(2)
})

test('a failed delivery offers a retry', () => {
  renderScreen([{ ...approval, delivery: 'failed' }])
  const bar = screen.getByRole('group', { name: 'Approval needed' })
  expect(bar.textContent).toContain('Couldn’t deliver your answer. Try again.')
  expect(within(bar).getByRole('button', { name: 'Retry' })).toHaveProperty('disabled', false)
})

test('a non-actionable approval links to its job when its card names one', () => {
  render(
    <MemoryRouter>
      <BoldScreenView
        agent={builder}
        frames={frames}
        markers={markers}
        approvals={[{ ...approval, actionable: false }]}
        jobs={[{ id: 'job-feed', title: 'Activity feed' } as Job]}
        messages={
          [
            {
              id: 'approval:approval-ws',
              roomId: 'team-room',
              jobId: 'job-feed',
              author: { kind: 'agent', agentId: 'builder' },
              to: [],
              parts: [{ kind: 'approval', approvalId: approval.id }],
              createdAt: approval.createdAt,
              streaming: false,
              refs: [],
            },
          ] satisfies Message[]
        }
      />
    </MemoryRouter>,
  )
  expect(screen.getByRole('link', { name: 'Answer in the job' }).getAttribute('href')).toBe(
    '/b?job=job-feed',
  )
})

const editorFrame: WatchFrame = {
  seq: 4,
  at: '2026-10-24T09:12:00.000Z',
  agentId: 'builder',
  runId: 'run-1',
  surface: 'editor',
  editor: { path: 'api/events.py', language: 'python', diff: '@@ -1,1 +1,2 @@\n a\n+b' },
  caption: 'Edited api/events.py',
}
const editorMarker: WatchMarker = { seq: 4, at: editorFrame.at, kind: 'file' }

test('the editor is the large frame; the terminal and browser are small and swap in on click', () => {
  render(
    <MemoryRouter>
      <BoldScreenView
        agent={builder}
        frames={[...frames, editorFrame]}
        markers={[...markers, editorMarker]}
        approvals={[]}
      />
    </MemoryRouter>,
  )
  expect(screen.getByLabelText('Changes to api/events.py')).toBeDefined()
  const small = screen.getByRole('group', { name: 'Other windows' })
  expect(within(small).getAllByRole('button')).toHaveLength(2)
  fireEvent.click(within(small).getByRole('button', { name: /^Browser, localhost:5173/ }))
  expect(screen.queryByLabelText('Changes to api/events.py')).toBeNull()
  expect(screen.getByText('Browser, localhost:5173')).toBeDefined()
  expect(within(small).getByRole('button', { name: /^Editor, api\/events.py/ })).toBeDefined()
})

test('the asked-you card is pinned above the step list', () => {
  renderScreen()
  const bar = screen.getByRole('group', { name: 'Approval needed' })
  expect(bar.textContent).toContain('Asked you at')
  expect(
    bar.compareDocumentPosition(screen.getByRole('region', { name: 'What builder did' })) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy()
})

test('pause and resume, with the failure said plainly', () => {
  const onToggle = vi.fn()
  const { rerender } = render(
    <MemoryRouter>
      <BoldScreenView
        agent={builder}
        frames={frames}
        markers={markers}
        approvals={[]}
        pause={{ pending: false, failed: false, onToggle }}
      />
    </MemoryRouter>,
  )
  fireEvent.click(screen.getByRole('button', { name: 'Pause builder' }))
  expect(onToggle).toHaveBeenCalledTimes(1)
  rerender(
    <MemoryRouter>
      <BoldScreenView
        agent={{ ...builder, status: 'paused' }}
        frames={frames}
        markers={markers}
        approvals={[]}
        pause={{ pending: false, failed: true, onToggle }}
      />
    </MemoryRouter>,
  )
  expect(screen.getByRole('button', { name: 'Resume builder' })).toBeDefined()
  expect(screen.getByRole('alert').textContent).toContain('Couldn’t resume builder')
})

test('copies the command that continues the agent’s session', async () => {
  const write = vi.fn(async () => undefined)
  vi.stubGlobal('navigator', { clipboard: { writeText: write } })
  render(
    <MemoryRouter>
      <BoldScreenView
        agent={builder}
        frames={frames}
        markers={markers}
        approvals={[]}
        resumeSession={async () => 'session-1'}
      />
    </MemoryRouter>,
  )
  fireEvent.click(screen.getByRole('button', { name: /Copy the command to continue/ }))
  const status = await screen.findByText(/Copied/)
  expect(status.textContent).toContain('hermes -p builder --resume session-1')
  expect(write).toHaveBeenCalledWith('hermes -p builder --resume session-1')
})

test('a from moment opens the replay there, and an older one says so', () => {
  const { rerender } = render(
    <MemoryRouter>
      <BoldScreenView agent={builder} frames={frames} markers={markers} approvals={[]} from={2} />
    </MemoryRouter>,
  )
  expect(screen.getByText('Replaying 09:14')).toBeDefined()
  rerender(
    <MemoryRouter>
      <BoldScreenView
        key="old"
        agent={builder}
        frames={frames}
        markers={markers}
        approvals={[]}
        from={0}
        gaps={2}
      />
    </MemoryRouter>,
  )
  expect(screen.getByText(/older than the history/)).toBeDefined()
  expect(screen.getByText(/Score missed some events \(2 gaps\)/)).toBeDefined()
})

test('other screens are chips that open each agent’s screen', () => {
  render(
    <MemoryRouter>
      <BoldScreenView
        agent={builder}
        frames={frames}
        markers={markers}
        approvals={[]}
        others={{
          failed: false,
          items: [
            { agent: builder, status: 'working', live: true, surface: 'terminal', thumbnail: null },
            {
              agent: { ...builder, id: 'reviewer', name: 'reviewer' },
              status: 'idle',
              live: false,
              surface: null,
              thumbnail: null,
            },
          ] as never,
        }}
      />
    </MemoryRouter>,
  )
  const nav = screen.getByRole('navigation', { name: 'Other screens' })
  const links = within(nav).getAllByRole('link')
  expect(links).toHaveLength(1)
  expect(links[0]!.getAttribute('href')).toBe('/b/screen/reviewer')
})

test('an agent with nothing on screen says so, with no frames at all', () => {
  render(
    <MemoryRouter>
      <BoldScreenView agent={builder} frames={[]} markers={[]} approvals={[]} />
    </MemoryRouter>,
  )
  expect(screen.getByText('builder hasn’t opened anything yet.')).toBeDefined()
  expect(screen.getByText('Nothing yet. Steps show up here as they happen.')).toBeDefined()
})

function many(count: number): { frames: WatchFrame[]; markers: WatchMarker[] } {
  const list: WatchFrame[] = Array.from({ length: count }, (_, index) => ({
    seq: index + 1,
    at: `2026-10-24T09:${String(10 + index).padStart(2, '0')}:00.000Z`,
    agentId: 'builder',
    runId: 'run-1',
    surface: 'terminal',
    terminal: { cwd: '~/app', command: `step ${index + 1}`, output: '', status: 'ok' },
    caption: `Did step ${index + 1}`,
  }))
  return {
    frames: list,
    markers: list.map((frame) => ({ seq: frame.seq, at: frame.at, kind: 'command' as const })),
  }
}

test('the step list is newest first, shows the five newest, and opens the full history', () => {
  const { frames: many8, markers: markers8 } = many(8)
  render(
    <MemoryRouter>
      <BoldScreenView agent={builder} frames={many8} markers={markers8} approvals={[]} />
    </MemoryRouter>,
  )
  const log = screen.getByRole('region', { name: 'What builder did' })
  const rows = within(log).getAllByRole('button', { name: /Did step/ })
  expect(rows).toHaveLength(5)
  expect(rows[0]!.textContent).toContain('Did step 8')
  expect(within(rows[0]!).getByRole('img', { name: 'Command' })).toBeDefined()
  fireEvent.click(within(log).getByRole('button', { name: 'Full history' }))
  expect(within(log).getAllByRole('button', { name: /Did step/ })).toHaveLength(8)
  fireEvent.click(within(log).getByRole('button', { name: 'Show less' }))
  expect(within(log).getAllByRole('button', { name: /Did step/ })).toHaveLength(5)
})

test('a replayed step outside the five newest opens the history so it stays visible', () => {
  const { frames: many8, markers: markers8 } = many(8)
  render(
    <MemoryRouter>
      <BoldScreenView agent={builder} frames={many8} markers={markers8} approvals={[]} from={1} />
    </MemoryRouter>,
  )
  const current = screen.getByRole('button', { name: /Did step 1/ })
  expect(current.getAttribute('aria-current')).toBe('true')
})

test('sub-agent steps are grouped', () => {
  const sub = (seq: number, parent: string): WatchFrame => ({
    seq,
    at: `2026-10-24T09:2${seq}:00.000Z`,
    agentId: 'builder',
    runId: 'run-1',
    surface: 'terminal',
    terminal: { cwd: '~/app', command: 'x', output: '', status: 'ok' },
    caption: `Sub-agent: read docs ${seq}`,
    parentCallId: parent,
  })
  const subs = [sub(5, 'call-1'), sub(6, 'call-1')]
  render(
    <MemoryRouter>
      <BoldScreenView
        agent={builder}
        frames={subs}
        markers={subs.map((f) => ({ seq: f.seq, at: f.at, kind: 'command' as const }))}
        approvals={[]}
      />
    </MemoryRouter>,
  )
  expect(screen.getByText('Sub-agent · 2 steps')).toBeDefined()
  expect(screen.getByRole('list', { name: 'Sub-agent steps' })).toBeDefined()
})

test('the stage and scrubber come before the step list in the page order', () => {
  renderScreen()
  const stage = screen.getByRole('group', { name: 'Replay timeline' })
  const log = screen.getByRole('region', { name: 'What builder did' })
  expect(stage.compareDocumentPosition(log) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
})

test('swapping a small card keeps focus on that button and announces the swap', () => {
  render(
    <MemoryRouter>
      <BoldScreenView
        agent={builder}
        frames={[...frames, editorFrame]}
        markers={[...markers, editorMarker]}
        approvals={[]}
      />
    </MemoryRouter>,
  )
  const small = screen.getByRole('group', { name: 'Other windows' })
  const button = within(small).getByRole('button', { name: /^Browser, / })
  button.focus()
  fireEvent.click(button)
  expect(document.activeElement).toBe(button)
  expect(button.getAttribute('aria-label')).toMatch(/^(Terminal|Editor), /)
  expect(within(small).getByRole('status').textContent).toBe('Browser is now the large screen.')
})

test('live, the large slot follows the newest frame; a click holds until a newer frame on another surface', () => {
  // The newest frame is the terminal one, so the terminal is large even though an editor frame exists.
  const withEditor = [editorFrame, ...frames]
  const withMarkers = [editorMarker, ...markers]
  const view = (f: WatchFrame[], m: WatchMarker[]) => (
    <MemoryRouter>
      <BoldScreenView agent={builder} frames={f} markers={m} approvals={[]} />
    </MemoryRouter>
  )
  const { rerender } = render(view(withEditor, withMarkers))
  expect(screen.queryByLabelText('Changes to api/events.py')).toBeNull()
  expect(screen.getAllByText('pnpm test api/events').length).toBeGreaterThan(0)
  fireEvent.click(screen.getByRole('button', { name: /^Editor, api\/events.py/ }))
  expect(screen.getByLabelText('Changes to api/events.py')).toBeDefined()
  // A newer frame on another surface lets go of the pin.
  const newer: WatchFrame = { ...frames[1]!, seq: 9, at: '2026-10-24T09:30:00.000Z' }
  rerender(
    view([...withEditor, newer], [...withMarkers, { seq: 9, at: newer.at, kind: 'browser' }]),
  )
  expect(screen.queryByLabelText('Changes to api/events.py')).toBeNull()
  expect(screen.getByText('http://localhost:5173/feed')).toBeDefined()
})

test('replay start is announced once, not on every scrub tick', () => {
  renderScreen()
  const status = () =>
    [...document.querySelectorAll('.sr-only[role="status"]')].map((node) => node.textContent)
  expect(status()).toContain('Live')
  fireEvent.click(screen.getByRole('button', { name: /Opened the activity feed/ }))
  expect(screen.getByText(/^Replaying /).getAttribute('role')).toBeNull()
  expect(status()).toContain('Replaying')
})
