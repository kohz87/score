import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createQueryClient } from '../data/query-client.ts'
import { BoldHome } from './BoldHome.tsx'

const disposed: (() => void)[] = []

function open() {
  const queryClient = createQueryClient()
  const router = createMemoryRouter([{ path: '*', element: <BoldHome /> }], {
    initialEntries: ['/b'],
  })
  disposed.push(() => {
    router.dispose()
    queryClient.clear()
  })
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
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
