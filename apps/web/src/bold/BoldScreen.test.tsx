import type { AgentSummary, Approval, WatchFrame, WatchMarker } from '@score/contract'
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
  expect(bar.getAttribute('data-protected')).toBe('any')
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
