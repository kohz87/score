import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createQueryClient, StreamContext } from '../data/query-client.ts'
import { createStreamQueryRegistry, immediateFrameScheduler } from '../data/resync.ts'
import { createStreamClient } from '../data/stream.ts'
import { BoldHome } from './BoldHome.tsx'

class Source extends EventTarget {
  close() {}
}

const disposed: (() => void)[] = []

function open() {
  const queryClient = createQueryClient()
  const client = createStreamClient({ EventSourceImpl: Source as never })
  const queries = createStreamQueryRegistry(queryClient, client, immediateFrameScheduler)
  const router = createMemoryRouter([{ path: '*', element: <BoldHome /> }], {
    initialEntries: ['/b'],
  })
  disposed.push(() => {
    router.dispose()
    queries.dispose()
    client.close()
    queryClient.clear()
  })
  render(
    <QueryClientProvider client={queryClient}>
      <StreamContext value={{ client, queries }}>
        <RouterProvider router={router} />
      </StreamContext>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  window.localStorage.clear()
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise<Response>(() => {})),
  )
})

afterEach(() => {
  cleanup()
  disposed.splice(0).forEach((dispose) => dispose())
  vi.unstubAllGlobals()
})

test('a cold team-room read shows a neutral placeholder instead of the room', () => {
  open()

  expect(screen.getByRole('status', { name: 'Finding the team room' })).toBeDefined()
  expect(screen.queryByRole('region', { name: 'Team room' })).toBeNull()
  expect(screen.queryByRole('heading', { name: 'Run a team of agents from one room.' })).toBeNull()
})
