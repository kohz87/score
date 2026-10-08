import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { AgentSummary, Approval, WatchFrame } from '@score/contract'
import { afterEach, expect, test, vi } from 'vitest'
import { WatchStage, type WatchStageProps } from './WatchStage.tsx'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const agent: AgentSummary = {
  id: 'builder',
  name: 'builder',
  role: 'Builds',
  style: { color: '#19C39A', shape: 'triangle' },
  status: 'working',
  activity: null,
  model: null,
  served: true,
}
const base = { agentId: 'builder', runId: null }
const terminalFrame: WatchFrame = {
  ...base,
  seq: 3,
  at: '2026-10-08T21:31:02.000Z',
  surface: 'terminal',
  terminal: {
    cwd: '/srv/app',
    command: 'npm install ws@8',
    output: 'added 1 package',
    status: 'paused',
  },
  caption: 'Tried to install',
}
const editorFrame: WatchFrame = {
  ...base,
  seq: 2,
  at: '2026-10-08T21:30:00.000Z',
  surface: 'editor',
  editor: {
    path: 'api/events.py',
    language: 'python',
    diff: '@@ -1,2 +1,2 @@\n keep\n-old line\n+new line\n',
  },
  caption: 'Edited events',
}
const browserFrame: WatchFrame = {
  ...base,
  seq: 1,
  at: '2026-10-08T21:29:00.000Z',
  surface: 'browser',
  browser: { url: 'http://localhost:5173/activity', title: 'Activity', imageUrl: null },
  caption: 'Opened the page',
}
const approval: Approval = {
  id: 'a1',
  origin: 'score-run',
  phase: 'human_pending',
  status: 'pending',
  actionable: true,
  linkedTo: null,
  agentId: 'builder',
  title: 'Install a package?',
  command: 'npm install ws@8',
  cwd: null,
  description: '',
  choices: ['once', 'deny'],
  createdAt: '2026-10-08T21:31:02.000Z',
  expiresAt: null,
  decision: null,
  delivery: 'none',
  blocking: null,
  refs: [],
}

function stage(props: Partial<WatchStageProps> = {}) {
  return render(
    <WatchStage
      agent={agent}
      bySurface={{ terminal: terminalFrame, editor: editorFrame, browser: browserFrame }}
      front={terminalFrame}
      replayAt={null}
      approval={null}
      history={[]}
      live
      {...props}
    />,
  )
}

test('the terminal pane shows the working directory, command, output and its status', () => {
  stage()
  const pane = screen.getByRole('group', { name: 'Terminal' })
  expect(within(pane).getByText('Terminal, /srv/app')).toBeTruthy()
  expect(within(pane).getByText('npm install ws@8', { exact: false })).toBeTruthy()
  expect(within(pane).getByText('added 1 package')).toBeTruthy()
  expect(within(pane).getByText('paused: waiting for approval').className).toContain(
    'watch-terminal__status--paused',
  )
})

test('earlier commands stay visible above the current one', () => {
  stage({
    history: [
      {
        ...terminalFrame,
        seq: 2,
        terminal: {
          ...terminalFrame.terminal!,
          command: 'pytest -q',
          output: 'all passed',
          status: 'ok',
        },
      },
    ],
  })
  const pane = screen.getByRole('group', { name: 'Terminal' })
  expect(within(pane).getByText('pytest -q', { exact: false })).toBeTruthy()
  expect(within(pane).getByText('all passed')).toBeTruthy()
})

test('the editor pane marks added and removed lines and numbers them', () => {
  stage({ front: editorFrame })
  const pane = screen.getByRole('group', { name: 'Editor' })
  expect(pane.getAttribute('data-front')).toBe('true')
  expect(within(pane).getAllByText('api/events.py').length).toBeGreaterThan(0)
  const added = within(pane).getByText('+new line').closest('.watch-diff')!
  const removed = within(pane).getByText('-old line').closest('.watch-diff')!
  expect(added.className).toContain('watch-diff--add')
  expect(added.querySelector('.watch-diff__number')?.textContent).toBe('2')
  expect(removed.className).toContain('watch-diff--del')
})

test('the browser pane shows the screenshot when there is one and a neutral page when not', () => {
  const { rerender } = stage({ front: browserFrame })
  const pane = screen.getByRole('group', { name: 'Browser' })
  expect(within(pane).getByText('localhost:5173/activity', { exact: false })).toBeTruthy()
  expect(within(pane).queryByRole('img')).toBeNull()
  rerender(
    <WatchStage
      agent={agent}
      bySurface={{
        browser: {
          ...browserFrame,
          browser: { ...browserFrame.browser!, imageUrl: '/api/media/shot-1' },
        },
      }}
      front={browserFrame}
      replayAt={null}
      approval={null}
      history={[]}
      live
    />,
  )
  expect(screen.getByRole('img', { name: 'Screenshot of Activity' }).getAttribute('src')).toBe(
    '/api/media/shot-1',
  )
})

test('the surface of the current frame comes to the front, and a tab brings another forward', () => {
  stage({ front: editorFrame })
  expect(screen.getByRole('group', { name: 'Editor' }).getAttribute('data-front')).toBe('true')
  expect(screen.getByRole('group', { name: 'Terminal' }).getAttribute('data-front')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Browser' }))
  expect(screen.getByRole('group', { name: 'Browser' }).getAttribute('data-front')).toBe('true')
  expect(screen.getByRole('button', { name: 'Browser' }).getAttribute('aria-pressed')).toBe('true')
})

test('the banner says you are watching while live and names the moment while replaying', () => {
  const { rerender } = stage()
  expect(screen.getByText("You're watching. builder is in control.")).toBeTruthy()
  rerender(
    <WatchStage
      agent={agent}
      bySurface={{ editor: editorFrame }}
      front={editorFrame}
      replayAt="2026-10-08T21:19:00.000Z"
      approval={approval}
      history={[]}
      live
    />,
  )
  expect(screen.queryByText(/You're watching/)).toBeNull()
  expect(screen.getByRole('status').textContent).toMatch(/^Replaying \d\d:\d\d$/)
  // A question that is open now does not belong on a replayed moment.
  expect(screen.queryByRole('group', { name: 'Approval needed' })).toBeNull()
})

test('without frames the stage says so instead of showing empty windows', () => {
  stage({ bySurface: {}, front: null, live: false })
  expect(screen.getByRole('status').textContent).toContain('No desktop open')
  expect(screen.queryByRole('group', { name: 'Terminal' })).toBeNull()
})

test('the approval bar names the command and answers through the decision endpoint', async () => {
  const fetchMock = vi.fn(() =>
    Promise.resolve(
      new Response(
        JSON.stringify({ ...approval, status: 'approved', actionable: false, phase: 'decided' }),
      ),
    ),
  )
  vi.stubGlobal('fetch', fetchMock)
  stage({ approval })
  const bar = screen.getByRole('group', { name: 'Approval needed' })
  expect(bar.textContent).toContain(
    'builder stopped before npm install ws@8 and is waiting for you',
  )
  fireEvent.click(within(bar).getByRole('button', { name: 'Approve' }))
  await waitFor(() => expect(fetchMock).toHaveBeenCalled())
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
  expect(url).toBe('/api/approvals/a1/decision')
  expect(JSON.parse(init.body as string)).toEqual({ choice: 'once' })
  await waitFor(() =>
    expect((within(bar).getByRole('button', { name: 'Deny' }) as HTMLButtonElement).disabled).toBe(
      true,
    ),
  )
})
