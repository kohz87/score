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
