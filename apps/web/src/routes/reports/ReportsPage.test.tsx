import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { createMemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { Reports } from '@score/contract'
import { App, appRoutes } from '../../App.tsx'
import { stubReducedMotion } from '../../motion/test-support.ts'
import { createQueryClient, StreamContext } from '../../data/query-client.ts'
import { createStreamQueryRegistry } from '../../data/resync.ts'
import { createStreamClient } from '../../data/stream.ts'
import {
  jsonResponse as json,
  reportAgents as agents,
  reportFixture as report,
} from '../../test/reports-fixtures.ts'

vi.mock('../../shell/use-needs-you.ts', () => ({ useNeedsYou: vi.fn(() => false) }))

class MockEventSource extends EventTarget {
  constructor(readonly url: string) {
    super()
  }
  close() {}
}
let router: ReturnType<typeof createMemoryRouter>
let registry: ReturnType<typeof createStreamQueryRegistry>
let stream: ReturnType<typeof createStreamClient>
let calls: string[]
let respond: (path: string) => Response

beforeEach(() => {
  stubReducedMotion()
  calls = []
  respond = (path) => {
    if (path === '/api/agents') return json({ asOfSeq: 0, items: agents })
    const range = new URL(path, 'http://x').searchParams.get('range') as Reports['range']
    if (path.startsWith('/api/reports')) return json(report(range))
    return json({ error: { code: 'not_found', message: 'No' } }, 404)
  }
  vi.stubGlobal(
    'fetch',
    vi.fn((path: string) => {
      calls.push(path)
      return Promise.resolve(respond(path))
    }),
  )
})
function mount(url = '/reports') {
  const queryClient = createQueryClient()
  queryClient.setDefaultOptions({ queries: { retry: false } })
  stream = createStreamClient({ EventSourceImpl: MockEventSource, random: () => 0.5 })
  registry = createStreamQueryRegistry(queryClient, stream)
  router = createMemoryRouter(appRoutes, { initialEntries: [url] })
  render(
    <QueryClientProvider client={queryClient}>
      <StreamContext value={{ client: stream, queries: registry }}>
        <App router={router} />
      </StreamContext>
    </QueryClientProvider>,
  )
}
afterEach(() => {
  cleanup()
  router.dispose()
  registry.dispose()
  stream.close()
  vi.unstubAllGlobals()
})

test('shows an error with a retry when the report fails', async () => {
  respond = (path) =>
    path === '/api/agents'
      ? json({ asOfSeq: 0, items: agents })
      : json({ error: { code: 'internal', message: 'Boom' } }, 500)
  mount()
  expect(await screen.findByRole('alert')).toBeDefined()
  expect(screen.getByRole('button', { name: 'Try again' })).toBeDefined()
})

test('a malformed custom date is a message, never an exception', async () => {
  const { customRangeError } = await import('./reports-queries.ts')
  expect(customRangeError('2026-13-01', '2026-13-02', '2026-10-09')).toBe('Pick both days.')
  expect(customRangeError('2026-02-30', '2026-03-01', '2026-10-09')).toBe('Pick both days.')
})
