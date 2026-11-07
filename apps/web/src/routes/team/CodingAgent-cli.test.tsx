import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { expect, test, vi } from 'vitest'
import {
  installCodingAgentTestSetup,
  json,
  personaAgent,
  runtimes,
} from './coding-agent-test-helpers.ts'

installCodingAgentTestSetup()

// 3.15.3 (decision 157): no "Run anyway" step; a newer version runs unless Score's check found it broken.
test('a newer CLI version: checked shows as such with no alert; a broken one says why, with nothing to confirm', async () => {
  const { CodingOverview } = await import('./CodingAgent.tsx')
  const view = (cli: object) => personaAgent({ id: 'coder', cli })
  const show = async (agent: object) => {
    vi.stubGlobal('fetch', async (path: string) => {
      if (path.endsWith('/quota')) return json({ quota: null })
      if (path.includes('/models')) return json({ models: [], source: 'none' })
      if (path.endsWith('/backend'))
        return json({ kind: 'unit', note: '', checks: [], checkedAt: '2026-10-11T00:00:00.000Z' })
      if (path.endsWith('/runtimes')) return json({ items: runtimes })
      return json({ items: [agent] })
    })
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <MemoryRouter>
          <CodingOverview agent={{ id: 'coder' } as never} />
        </MemoryRouter>
      </QueryClientProvider>,
    )
  }
  await show(
    view({ state: 'untested_version', version: '1.2.0', testedVersions: ['1.0.0'], problem: null }),
  )
  expect(await screen.findByText(/newer than tested; Score checked it/)).toBeDefined()
  expect(screen.queryByRole('region', { name: 'Needs attention' })).toBeNull()
  cleanup()
  await show(
    view({
      state: 'untested_version',
      version: '1.3.0',
      testedVersions: ['1.0.0'],
      problem: 'Claude Code 1.3.0 no longer describes --strict-mcp-config the way Score relies on.',
    }),
  )
  const alert = await screen.findByRole('region', { name: 'Needs attention' })
  expect(alert.textContent).toContain('1.3.0 can’t run')
  expect(alert.textContent).toContain('no longer describes --strict-mcp-config')
  expect(within(alert).queryByRole('button')).toBeNull()
})
