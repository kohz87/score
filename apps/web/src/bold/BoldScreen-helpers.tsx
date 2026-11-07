import type { AgentSummary, Approval, WatchFrame, WatchMarker } from '@score/contract'
import { cleanup, render } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, vi } from 'vitest'
import { BoldScreenView } from './BoldScreen.tsx'

export const builder: AgentSummary = {
  id: 'builder',
  name: 'builder',
  role: 'Builds features',
  style: { color: '#19C39A', shape: 'triangle' },
  status: 'working',
  activity: 'Waiting for your OK',
  model: { id: 'fake-model', label: 'Demo model' },
  served: true,
}

export const frames: WatchFrame[] = [
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

export const markers: WatchMarker[] = [
  { seq: 1, at: '2026-10-24T09:08:00.000Z', kind: 'command' },
  { seq: 2, at: '2026-10-24T09:14:00.000Z', kind: 'browser' },
  { seq: 3, at: '2026-10-24T09:16:00.000Z', kind: 'command' },
]

export const approval: Approval = {
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

export function renderScreen(approvals: Approval[] = [approval]) {
  render(
    <MemoryRouter>
      <BoldScreenView agent={builder} frames={frames} markers={markers} approvals={approvals} />
    </MemoryRouter>,
  )
}

export const editorFrame: WatchFrame = {
  seq: 4,
  at: '2026-10-24T09:12:00.000Z',
  agentId: 'builder',
  runId: 'run-1',
  surface: 'editor',
  editor: { path: 'api/events.py', language: 'python', diff: '@@ -1,1 +1,2 @@\n a\n+b' },
  caption: 'Edited api/events.py',
}

export const editorMarker: WatchMarker = { seq: 4, at: editorFrame.at, kind: 'file' }
