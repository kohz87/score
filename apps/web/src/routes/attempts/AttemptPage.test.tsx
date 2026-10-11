import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { AttemptDetail } from '@score/contract'
import { createQueryClient, StreamContext } from '../../data/query-client.ts'
import { createStreamQueryRegistry } from '../../data/resync.ts'
import { createStreamClient } from '../../data/stream.ts'
import { AttemptPage } from './AttemptPage.tsx'

class Source extends EventTarget {
  close() {}
}

const attempt = (over: Partial<AttemptDetail> = {}): AttemptDetail => ({
  id: 'kr_old',
  kind: 'kanban',
  agentId: null,
  role: null,
  status: 'ended_unknown',
  closureReason: null,
  startedAt: '2026-10-08T10:00:00.000Z',
  endedAt: null,
  observationEndedAt: '2026-10-08T10:30:00.000Z',
  evidence: 'partial',
  taskId: 't9',
  task: { taskId: 't9', historyId: 'h0', current: false },
  order: ['2026-10-08T10:00:00.000Z', 4],
  refusedUpdates: 0,
  tools: null,
  session: null,
  model: null,
  taskSnapshot: { title: 'Port the importer', status: 'running', assignee: 'builder' },
  ...over,
})

let body: unknown
let status = 200
const cleanups: (() => void)[] = []
beforeEach(() => {
  body = attempt()
  status = 200
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) =>
      Promise.resolve(
        new Response(
          JSON.stringify(
            String(input) === '/api/attempts/kr_old'
              ? body
              : String(input) === '/api/agents'
                ? { items: [] }
                : body,
          ),
          { status },
        ),
      ),
    ),
  )
})
afterEach(() => {
  cleanup()
  cleanups.splice(0).forEach((fn) => fn())
  vi.unstubAllGlobals()
})

function renderPage() {
  const queryClient = createQueryClient()
  const client = createStreamClient({ EventSourceImpl: Source })
  const queries = createStreamQueryRegistry(queryClient, client)
  cleanups.push(() => {
    queries.dispose()
    client.close()
    queryClient.clear()
  })
  const router = createMemoryRouter([{ path: '/attempts/:attemptId', element: <AttemptPage /> }], {
    initialEntries: ['/attempts/kr_old'],
  })
  render(
    <QueryClientProvider client={queryClient}>
      <StreamContext value={{ client, queries }}>
        <RouterProvider router={router} />
      </StreamContext>
    </QueryClientProvider>,
  )
}

test('shows the frozen task read-only, from an earlier copy of the board, with no Watch link', async () => {
  renderPage()
  await screen.findByRole('heading', { level: 1, name: /Run by an unknown agent/ })
  expect(screen.getByText(/From an earlier copy of the board/)).toBeTruthy()
  const task = screen.getByRole('region', { name: 'Task as last seen' })
  expect(within(task).getByText('Port the importer')).toBeTruthy()
  expect(screen.getByText(/No longer seen since/)).toBeTruthy()
  expect(screen.getByText('Source unclear')).toBeTruthy()
  expect(screen.queryAllByRole('button')).toHaveLength(0)
  expect(screen.queryAllByRole('link').map((link) => link.getAttribute('href'))).toEqual(['/tasks'])
  expect(screen.getByText('Watch').nextSibling?.textContent).toBe('Not recorded')
})

test('an unknown run says it is not available', async () => {
  status = 404
  body = { error: { code: 'not_found', message: 'no' } }
  renderPage()
  expect(await screen.findByText('This run isn’t available.')).toBeTruthy()
})
