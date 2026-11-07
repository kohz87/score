import type { WatchFrame, WatchMarker } from '@score/contract'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { expect, test, vi } from 'vitest'
import {
  builder,
  editorFrame,
  editorMarker,
  frames,
  markers,
  renderScreen,
} from './BoldScreen-helpers.tsx'
import { BoldScreenView } from './BoldScreen.tsx'

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
