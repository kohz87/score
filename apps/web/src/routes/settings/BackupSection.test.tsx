import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { StreamClient } from '../../data/stream.ts'
import { createQueryClient, StreamContext } from '../../data/query-client.ts'
import { createStreamQueryRegistry, immediateFrameScheduler } from '../../data/resync.ts'
import { fenceKey } from '../orchestrations/orchestration-queries.ts'
import { BackupSection } from './BackupSection.tsx'

const fence = (fenced: boolean) => ({
  fenced,
  reason: fenced ? 'restore' : null,
  untrustedHistory: fenced,
  revision: fenced ? 1 : 2,
  since: fenced ? '2026-10-24T09:00:00.000Z' : null,
  items: [],
  journal: { ok: true, entries: 4, bytes: 1200, sizeAlarm: false },
})

const disposers: (() => void)[] = []

function mount() {
  const queryClient = createQueryClient()
  queryClient.setDefaultOptions({ queries: { retry: false } })
  const stream = {
    subscribe: () => () => undefined,
    onControl: () => () => undefined,
  } as unknown as StreamClient
  const queries = createStreamQueryRegistry(queryClient, stream, immediateFrameScheduler)
  disposers.push(() => {
    queries.dispose()
    queryClient.clear()
  })
  render(
    <QueryClientProvider client={queryClient}>
      <StreamContext value={{ client: stream, queries }}>
        <BackupSection />
      </StreamContext>
    </QueryClientProvider>,
  )
  return queryClient
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(fence(true)))),
  )
})

afterEach(() => {
  cleanup()
  disposers.splice(0).forEach((dispose) => dispose())
  vi.unstubAllGlobals()
})

test('Backup shows the fence review itself, not a dead link, and removes it when lifted', async () => {
  const queryClient = mount()
  expect(
    await screen.findByRole('heading', {
      name: 'Starting work is blocked until you review this list',
    }),
  ).toBeDefined()
  expect(screen.queryByText(/Check the runs waiting for review/)).toBeNull()
  expect(screen.getByRole('button', { name: 'Lift the block' })).toBeDefined()

  act(() => queryClient.setQueryData(fenceKey, fence(false)))
  await waitFor(() =>
    expect(
      screen.queryByRole('heading', {
        name: 'Starting work is blocked until you review this list',
      }),
    ).toBeNull(),
  )
  expect(screen.getByText(/Nothing is blocked/)).toBeDefined()
})
