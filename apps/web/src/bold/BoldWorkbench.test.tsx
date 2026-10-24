import type { AgentSummary, Workbench } from '@score/contract'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, expect, test, vi } from 'vitest'
import { BoldWorkbenchView } from './BoldWorkbench.tsx'

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

const agents = [builder, reviewer]
const job = { id: 'job-feed', title: 'Activity feed', state: 'working' as const }

const workbench: Workbench = {
  asOfSeq: 12,
  files: [
    {
      path: 'api/events.py',
      language: 'python',
      exact: false,
      lines: [
        { n: 1, text: 'PAGE_SIZE = 50', by: 'builder' },
        { n: 2, text: 'def page(after):', by: 'builder' },
        { n: 3, text: '    return rows[:PAGE_SIZE]', by: 'builder' },
      ],
      cursors: [{ agentId: 'builder', line: 3, at: '2026-10-24T10:04:00.000Z' }],
      comments: [
        {
          id: 'note-send-back',
          by: 'reviewer',
          line: null,
          originalLine: 2,
          text: 'Two events in one millisecond: the second is skipped.',
          outdated: true,
          exchangeId: 'exchange-1',
          kind: 'send_back',
          at: '2026-10-24T09:15:00.000Z',
        },
        {
          id: 'note-approve',
          by: 'reviewer',
          line: 3,
          originalLine: 3,
          text: 'Nice: the page size is one constant.',
          outdated: false,
          exchangeId: 'exchange-2',
          kind: 'approve',
          at: '2026-10-24T09:20:00.000Z',
        },
      ],
      editedBy: ['builder'],
      lastEditAt: '2026-10-24T09:10:00.000Z',
    },
    {
      path: 'api/test_events.py',
      language: 'python',
      exact: true,
      lines: [{ n: 1, text: 'def test_same_millisecond():', by: 'builder' }],
      cursors: [],
      comments: [],
      editedBy: ['builder'],
      lastEditAt: '2026-10-24T09:10:00.000Z',
    },
  ],
  looseComments: [
    {
      id: 'note-loose',
      by: 'reviewer',
      line: 4,
      originalLine: 4,
      path: 'docs/other.md',
      text: 'This sentence can be shorter.',
      outdated: false,
      exchangeId: null,
      kind: 'review',
      at: '2026-10-24T09:30:00.000Z',
    },
  ],
  drafts: [
    {
      kind: 'draft',
      id: 'draft-empty-states',
      agentId: 'reviewer',
      title: 'Empty states',
      target: { kind: 'workspace', path: 'docs/writing/empty-states.md' },
      at: '2026-10-24T09:40:00.000Z',
    },
  ],
  screens: [
    {
      live: true,
      frame: {
        seq: 12,
        at: '2026-10-24T10:05:00.000Z',
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
    },
  ],
}

afterEach(cleanup)

function renderWorkbench(
  work: string,
  opts: { hidden?: boolean; failed?: boolean } = {},
  data: Workbench = workbench,
) {
  const onWorkChange = vi.fn()
  render(
    <MemoryRouter>
      <BoldWorkbenchView
        job={job}
        workbench={data}
        agents={agents}
        work={work}
        hidden={opts.hidden}
        failed={opts.failed}
        onWorkChange={onWorkChange}
      />
    </MemoryRouter>,
  )
  return onWorkChange
}

test('code shows builder’s colour bar, both reviewer notes and the cursor without an editor', () => {
  renderWorkbench('code')
  const bench = screen.getByTestId('bold-workbench')
  const code = within(bench).getByRole('region', { name: 'Code in api/events.py' })
  const authored = code.querySelectorAll('[data-by="builder"]')
  expect(authored.length).toBeGreaterThanOrEqual(3)
  expect((authored[0] as HTMLElement).style.getPropertyValue('--line-colour')).toBe('#19C39A')
  expect((authored[0] as HTMLElement).querySelector('.bold-bench-bar')).not.toBeNull()
  expect((authored[0] as HTMLElement).getAttribute('title')).toBe('Written by builder')
  expect((authored[0] as HTMLElement).querySelector('.bold-bench-sr')?.textContent).toBe(
    'Written by builder',
  )

  const sendBack = code.querySelector('[data-comment="send_back"]') as HTMLElement
  expect(sendBack.textContent).toContain('Two events in one millisecond')
  expect(sendBack.textContent).toContain('Outdated · was line 2')
  expect(sendBack.getAttribute('data-outdated')).toBe('true')
  expect(code.querySelector('[data-line="2"] + .bold-bench-comment-row')).not.toBeNull()

  const approve = code.querySelector('[data-comment="approve"]') as HTMLElement
  expect(approve.textContent).toContain('Nice: the page size is one constant.')
  expect(approve.textContent).toContain('Approved')
  expect(code.querySelector('[data-cursor="builder"]')).not.toBeNull()
  expect(within(code).getByText('Authorship may be incomplete for this file.')).toBeDefined()
  expect(within(code).getByRole('link', { name: 'Files' }).getAttribute('href')).toBe(
    '/b/team/builder#agent-workspace',
  )
  expect(bench.querySelector('input, textarea, [contenteditable="true"]')).toBeNull()
})

test('tabs choose a file, a screen and a draft, and mark the active one', () => {
  const onWorkChange = renderWorkbench('code')
  const tabs = screen.getByRole('group', { name: 'Workbench files and screens' })
  expect(
    within(tabs)
      .getByRole('button', { name: /api\/events\.py/ })
      .getAttribute('aria-pressed'),
  ).toBe('true')
  fireEvent.click(within(tabs).getByRole('button', { name: /builder.s screen/ }))
  expect(onWorkChange).toHaveBeenCalledWith('screen')

  cleanup()
  renderWorkbench('screen')
  const stage = screen.getByRole('region', { name: 'builder’s screen' })
  expect(within(stage).getByText('Read-only · you’re watching')).toBeDefined()
  expect(within(stage).getByText('pnpm test api/events')).toBeDefined()
  expect(
    within(stage).getByRole('link', { name: 'Open full screen and replay' }).getAttribute('href'),
  ).toBe('/b/screen/builder')
  expect(stage.querySelector('input, textarea, [contenteditable="true"]')).toBeNull()

  cleanup()
  renderWorkbench('draft')
  const draft = screen.getByRole('article')
  expect(within(draft).getByRole('heading', { name: 'Empty states' })).toBeDefined()
  expect(within(draft).getByText('reviewer')).toBeDefined()
  expect(
    within(draft).getByRole('link', { name: 'Open in the workspace' }).getAttribute('href'),
  ).toBe('/b/team/reviewer?path=docs%2Fwriting%2Fempty-states.md#agent-workspace')
})

test('arrow keys move through the tabs and leave one tab in the tab order', async () => {
  const onWorkChange = renderWorkbench('code')
  const tabs = screen.getByRole('group', { name: 'Workbench files and screens' })
  const file = within(tabs).getByRole('button', { name: /api\/events\.py/ })
  const screenTab = within(tabs).getByRole('button', { name: /builder.s screen/ })
  expect(file.getAttribute('tabindex')).toBe('0')
  expect(screenTab.getAttribute('tabindex')).toBe('-1')

  const secondFile = within(tabs).getByRole('button', { name: /api\/test_events\.py/ })
  secondFile.focus()
  fireEvent.keyDown(secondFile, { key: 'ArrowRight' })
  expect(onWorkChange).toHaveBeenCalledWith('screen')
  await waitFor(() => expect(document.activeElement).toBe(screenTab))
})

test('a screen tab keeps its node and focus when the agent’s next frame arrives', () => {
  const { rerender } = render(
    <MemoryRouter>
      <BoldWorkbenchView job={job} workbench={workbench} agents={agents} work="screen" />
    </MemoryRouter>,
  )
  const tabs = screen.getByRole('group', { name: 'Workbench files and screens' })
  const before = within(tabs).getByRole('button', { name: /builder.s screen/ })
  before.focus()

  const next: Workbench = {
    ...workbench,
    screens: [
      {
        ...workbench.screens[0]!,
        frame: {
          ...workbench.screens[0]!.frame,
          seq: 13,
          at: '2026-10-24T10:06:00.000Z',
          caption: 'Ran the tests again',
        },
      },
    ],
  }
  rerender(
    <MemoryRouter>
      <BoldWorkbenchView job={job} workbench={next} agents={agents} work="screen" />
    </MemoryRouter>,
  )
  expect(within(tabs).getByRole('button', { name: /builder.s screen/ })).toBe(before)
  expect(document.activeElement).toBe(before)
})

test('a cursor on a line Score never saw lands on the nearest known line, or in the file header', () => {
  const file = workbench.files[0]!
  const unseen: Workbench = {
    ...workbench,
    files: [
      {
        ...file,
        cursors: [{ agentId: 'builder', line: 99, at: '2026-10-24T10:04:00.000Z' }],
      },
    ],
  }
  renderWorkbench('code', {}, unseen)
  const code = screen.getByRole('region', { name: 'Code in api/events.py' })
  expect(code.querySelector('[data-line="3"] [data-cursor="builder"]')).not.toBeNull()

  cleanup()
  renderWorkbench(
    'code',
    {},
    {
      ...workbench,
      files: [{ ...file, cursors: [{ ...file.cursors[0]!, line: null }] }],
    },
  )
  const header = screen.getByRole('region', { name: 'Code in api/events.py' })
  expect(header.querySelector('.bold-bench-head-cursors [data-cursor="builder"]')).not.toBeNull()
})

test('loading, failure, an empty job and a hidden panel each have a clear state', () => {
  const { rerender } = render(
    <MemoryRouter>
      <BoldWorkbenchView job={job} workbench={undefined} agents={agents} work="code" pending />
    </MemoryRouter>,
  )
  expect(screen.getByRole('status').textContent).toContain('Loading the Workbench')

  rerender(
    <MemoryRouter>
      <BoldWorkbenchView
        job={job}
        workbench={undefined}
        agents={agents}
        work="code"
        failed
        onRetry={() => {}}
      />
    </MemoryRouter>,
  )
  expect(screen.getByRole('alert').textContent).toContain('Couldn’t load the Workbench')

  rerender(
    <MemoryRouter>
      <BoldWorkbenchView job={job} workbench={workbench} agents={agents} work="code" hidden />
    </MemoryRouter>,
  )
  expect(screen.getByTestId('bold-workbench').hasAttribute('hidden')).toBe(true)

  rerender(
    <MemoryRouter>
      <BoldWorkbenchView job={null} workbench={undefined} agents={agents} work="code" />
    </MemoryRouter>,
  )
  expect(screen.getByText('Pick a job in the room to see its Workbench.')).toBeDefined()
})
