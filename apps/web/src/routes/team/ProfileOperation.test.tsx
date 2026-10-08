import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { AgentOperation } from '@score/contract'
import { afterEach, expect, test, vi } from 'vitest'
import { ProfileOperation } from './ProfileOperation.tsx'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const interrupted: AgentOperation = {
  id: '11111111-1111-4111-8111-111111111111',
  kind: 'create',
  targetName: 'builder',
  state: 'needs_attention',
  nextStep: 'create_profile',
  steps: [
    { name: 'create_profile', state: 'running' },
    { name: 'preserve_key', state: 'pending' },
  ],
  error: 'Next step: create_profile. The step could not be verified.',
  exportPath: null,
  createdAt: '2026-10-08T10:00:00.000Z',
  updatedAt: '2026-10-08T10:00:05.000Z',
  retryable: false,
  confirmable: true,
} as AgentOperation

test('an interrupted step asks the person to check it, then confirms that exact step', async () => {
  const fetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(() =>
    Promise.resolve(Response.json({ ...interrupted, state: 'running', confirmable: false })),
  )
  vi.stubGlobal('fetch', fetch)
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ProfileOperation operation={interrupted} />
    </QueryClientProvider>,
  )
  expect(screen.getByText(/Score lost track of “Create profile”/).textContent).toContain(
    'the profile builder exists',
  )
  expect(screen.queryByRole('button', { name: /Retry/ })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'I checked: it finished, continue' }))
  await waitFor(() => expect(fetch).toHaveBeenCalled())
  const [url, init] = fetch.mock.calls[0]!
  expect(url).toBe(`/api/agents/operations/${interrupted.id}/confirm`)
  expect(JSON.parse(String(init!.body))).toEqual({ step: 'create_profile' })
})
