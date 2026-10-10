import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, expect, test, vi } from 'vitest'
import type { AgentSummary, Message, RoomVersion } from '@score/contract'
import { createQueryClient } from '../../data/query-client.ts'
import { DeletedBlock, versionChain } from './versions.tsx'

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

test('versionChain walks back through corrections of corrections, oldest first', () => {
  const v1 = version({ id: 'v1', anchorId: 'a', mode: 'edit', replacedBy: 'b' })
  const v2 = version({ id: 'v2', anchorId: 'b', mode: 'edit', replacedBy: 'c' })
  const del = version({ id: 'v3', anchorId: 'z', mode: 'delete' })
  expect(versionChain('c', [del, v2, v1]).map((item) => item.id)).toEqual(['v1', 'v2'])
  expect(versionChain('b', [del, v2, v1]).map((item) => item.id)).toEqual(['v1'])
  expect(versionChain('a', [del, v2, v1])).toEqual([])
})

test('a deleted block that hid a correction keeps that correction`s own version control', async () => {
  const outer = version({ id: 'v2', anchorId: 'w', mode: 'delete' })
  const edit = version({ id: 'v1', anchorId: 'x', mode: 'edit', replacedBy: 'y' })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/versions/x'))
        return new Response(JSON.stringify({ version: edit, items: [mine('x', 'original')] }))
      return new Response(
        JSON.stringify({ version: outer, items: [mine('w', 'earlier'), mine('y', 'corrected')] }),
      )
    }),
  )
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter>
        <DeletedBlock version={outer} versions={[outer, edit]} agents={agents} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  await waitFor(() => expect(screen.getByText('corrected')).toBeDefined())
  expect(screen.getByText('Version 2 of 2')).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: 'Previous version' }))
  await waitFor(() => expect(screen.getByText('original')).toBeDefined())
  // The older branch replaces the correction (and what followed it inside this block); 'earlier' stays.
  expect(screen.queryByText('corrected')).toBeNull()
  expect(screen.getByText('earlier')).toBeDefined()
  expect(screen.getByText(/Viewing version 1 of 2/)).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: 'Back to latest' }))
  expect(screen.getByText('corrected')).toBeDefined()
})
