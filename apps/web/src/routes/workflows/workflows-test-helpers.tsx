import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, vi } from 'vitest'
import {
  okValidation,
  runSnapshot,
  unfinishedValidation,
  workflowFixtures,
  workflowPreflight,
} from '../../../../../e2e/workflow-fixtures.ts'
import { createQueryClient, StreamContext } from '../../data/query-client.ts'
import { createStreamQueryRegistry } from '../../data/resync.ts'
import { createStreamClient } from '../../data/stream.ts'

export class Source extends EventTarget {
  close() {}
}

export const agents = [
  {
    id: 'lead',
    name: 'lead',
    style: { color: '#6B4EFF', shape: 'circle-dot' },
    status: 'idle',
    role: '',
  },
  {
    id: 'builder',
    name: 'builder',
    style: { color: '#19C39A', shape: 'square' },
    status: 'idle',
    role: '',
  },
  {
    id: 'reviewer',
    name: 'reviewer',
    style: { color: '#FFB61E', shape: 'triangle' },
    status: 'idle',
    role: '',
  },
]

export const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status })

type WorkflowPostHandler = (url: string, init?: RequestInit) => Response | undefined

export const revisionOf = (patch: (run: Record<string, unknown>) => void) => {
  const copy = structuredClone(runSnapshot) as unknown as { run: Record<string, unknown> }
  patch(copy.run)
  return copy
}

export const started = () => {}

export function setUpWorkflowTests() {
  const state: {
    requests: { url: string; init?: RequestInit }[]
    snapshot: unknown
    post: WorkflowPostHandler
  } = {
    requests: [],
    snapshot: runSnapshot,
    post: () => undefined,
  }
  const dispose: (() => void)[] = []

  beforeEach(() => {
    state.requests = []
    state.snapshot = runSnapshot
    state.post = () => undefined
    vi.stubGlobal(
      'matchMedia',
      (query: string) =>
        ({
          matches: false,
          media: query,
          addEventListener() {},
          removeEventListener() {},
        }) as unknown as MediaQueryList,
    )
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        state.requests.push({ url, ...(init ? { init } : {}) })
        const method = init?.method ?? 'GET'
        if (method === 'POST') {
          const custom = state.post(url, init)
          if (custom) return Promise.resolve(custom)
          if (url === '/api/workflows/validate') {
            const body = JSON.parse(String(init?.body)) as { definition: { name: string } }
            return Promise.resolve(
              json(body.definition.name.includes('(draft)') ? unfinishedValidation : okValidation),
            )
          }
        }
        if (url === '/api/agents') return Promise.resolve(json({ asOfSeq: 1, items: agents }))
        if (url === '/api/workflow-runs/wfrun-1') return Promise.resolve(json(state.snapshot))
        if (url.startsWith('/api/workflow-runs/preflight'))
          return Promise.resolve(json(workflowPreflight))
        const fixture = workflowFixtures[url]
        return Promise.resolve(
          fixture === undefined
            ? json({ error: { code: 'not_found', message: 'none' } }, 404)
            : json(fixture),
        )
      }),
    )
  })

  afterEach(() => {
    cleanup()
    dispose.splice(0).forEach((fn) => fn())
    vi.unstubAllGlobals()
  })

  function providers(children: React.ReactNode) {
    const queryClient = createQueryClient()
    const client = createStreamClient({ EventSourceImpl: Source })
    const queries = createStreamQueryRegistry(queryClient, client)
    dispose.push(() => {
      queries.dispose()
      client.close()
      queryClient.clear()
    })
    return (
      <QueryClientProvider client={queryClient}>
        <StreamContext value={{ client, queries }}>{children}</StreamContext>
      </QueryClientProvider>
    )
  }

  function mount(ui: React.ReactElement) {
    render(providers(<MemoryRouter>{ui}</MemoryRouter>))
  }

  return { state, mount, dispose }
}
