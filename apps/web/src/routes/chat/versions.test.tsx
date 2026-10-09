import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, expect, test, vi } from 'vitest'
import type { AgentSummary, Message, RoomVersion } from '@score/contract'
import { createQueryClient } from '../../data/query-client.ts'
import { VersionSwitcher } from './versions.tsx'

// audit5-e: an edit whose correction a later rewind hid keeps its version switcher inside the hidden version.
const agents: AgentSummary[] = []
const mine = (id: string, text: string): Message => ({
  id,
  roomId: 'general',
  author: { kind: 'you' },
  to: [],
  parts: [{ kind: 'text', text }],
  createdAt: '2026-10-09T10:00:00.000Z',
  streaming: false,
  refs: [],
})
const version = (patch: Partial<RoomVersion>): RoomVersion => ({
  id: 'v',
  roomId: 'general',
  anchorId: 'a',
  anchorCreatedAt: '2026-10-09T10:00:00.000Z',
  mode: 'delete',
  replacedBy: null,
  number: 1,
  count: 2,
  hiddenCount: 1,
  rewound: [],
  skipped: [],
  createdAt: '2026-10-09T10:00:01.000Z',
  ...patch,
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

test('viewing a rewind that hid a correction still offers the edit history behind it', async () => {
  const outer = version({ id: 'v2', anchorId: 'w', mode: 'delete' })
  const edit = version({ id: 'v1', anchorId: 'x', mode: 'edit', replacedBy: 'y' })
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({ version: outer, items: [mine('w', 'earlier'), mine('y', 'corrected')] }),
        ),
    ),
  )
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter>
        <VersionSwitcher version={outer} versions={[outer, edit]} agents={agents} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  fireEvent.click(screen.getByRole('button', { name: 'View' }))
  await waitFor(() => expect(screen.getByText('corrected')).toBeDefined())
  expect(screen.getAllByTestId('version-switcher')).toHaveLength(2)
  expect(screen.getByRole('button', { name: 'Previous version' })).toBeDefined()
})
