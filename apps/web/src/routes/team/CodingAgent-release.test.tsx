import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { installCodingAgentTestSetup } from './coding-agent-test-helpers.ts'

installCodingAgentTestSetup()

test('Release: shown only for groups Score can’t attribute, posts once and names nothing internal', async () => {
  const { ReleaseHeld } = await import('./ReleaseHeld.tsx')
  const agent = (canRelease: boolean) => ({
    id: 'coder',
    name: 'Coder',
    role: '',
    instructions: '',
    instructionsEtag: 'e0',
    runtime: 'claude-code',
    workspace: '/w',
    permission: 'workspace-write',
    model: null,
    style: { color: '#6B4EFF', shape: 'hexagon' },
    quota: 'q',
    quotaFloorPercent: 10,
    cli: { state: 'ready', version: '1.0.0', testedVersions: ['1.0.0'], problem: null },
    heldGroups: [{ runId: 'cr_1', pgid: 4242, canRelease }],
    createdAt: '2026-10-11T00:00:00.000Z',
  })
  let releasable = false
  const releases: string[] = []
  vi.stubGlobal('fetch', async (path: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      releases.push(path)
      releasable = false
      return new Response(JSON.stringify({ ...agent(false), heldGroups: [] }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({ items: [agent(releasable)] }), {
      headers: { 'Content-Type': 'application/json' },
    })
  })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(
    <QueryClientProvider client={client}>
      <ReleaseHeld agentId="coder" />
    </QueryClientProvider>,
  )
  // A group that is merely still running is not the person's to release.
  await waitFor(() => expect(client.getQueryData(['coding', 'agents'])).toBeDefined())
  expect(screen.queryByRole('button', { name: 'Release agent' })).toBeNull()
  view.unmount()
  releasable = true
  client.clear()
  render(
    <QueryClientProvider client={client}>
      <ReleaseHeld agentId="coder" />
    </QueryClientProvider>,
  )
  const button = await screen.findByRole('button', { name: 'Release agent' })
  expect(screen.getByText(/ps -o pid,pgid,args -g 4242/)).toBeTruthy()
  fireEvent.click(button)
  await waitFor(() => expect(releases).toEqual(['/api/coding-agents/coder/release']))
})

test('Release: a supervised run is named by its service, not by a process group', async () => {
  const { ReleaseHeld } = await import('./ReleaseHeld.tsx')
  vi.stubGlobal(
    'fetch',
    async () =>
      new Response(
        JSON.stringify({
          items: [
            {
              id: 'coder',
              name: 'Coder',
              role: '',
              instructions: '',
              instructionsEtag: 'e0',
              runtime: 'claude-code',
              workspace: '/w',
              permission: 'workspace-write',
              model: null,
              style: { color: '#6B4EFF', shape: 'hexagon' },
              quota: 'q',
              quotaFloorPercent: 10,
              cli: {
                state: 'ready',
                version: '1.0.0',
                testedVersions: ['1.0.0'],
                problem: null,
              },
              heldGroups: [
                { runId: 'cr_1', pgid: 0, canRelease: true, unit: 'score-01234567-c-abc.service' },
              ],
              createdAt: '2026-10-11T00:00:00.000Z',
            },
          ],
        }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
  )
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <ReleaseHeld agentId="coder" />
    </QueryClientProvider>,
  )
  expect(
    await screen.findByText(/systemctl --user status score-01234567-c-abc.service/),
  ).toBeTruthy()
  expect(screen.queryByText(/ps -o pid/)).toBeNull()
})
