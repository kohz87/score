import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { orchestrationFixtures } from '../../../../../e2e/orchestration-fixtures.ts'
import { workflowFixtures } from '../../../../../e2e/workflow-fixtures.ts'
import { createQueryClient, StreamContext } from '../../data/query-client.ts'
import { createStreamQueryRegistry } from '../../data/resync.ts'
import { createStreamClient } from '../../data/stream.ts'
import { RunDetails } from './RunDetails.tsx'

class Source extends EventTarget {
  close() {}
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status })
const disposers: (() => void)[] = []

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      const fixture = orchestrationFixtures[url] ?? workflowFixtures[url]
      if (url === '/api/agents') return Promise.resolve(json({ asOfSeq: 1, items: [] }))
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
  disposers.splice(0).forEach((dispose) => dispose())
  vi.unstubAllGlobals()
})

function mount(recipe: { kind: 'orchestration' | 'workflow'; ref: string }) {
  const queryClient = createQueryClient()
  const client = createStreamClient({ EventSourceImpl: Source })
  const queries = createStreamQueryRegistry(queryClient, client)
  disposers.push(() => {
    queries.dispose()
    client.close()
    queryClient.clear()
  })
  render(
    <QueryClientProvider client={queryClient}>
      <StreamContext value={{ client, queries }}>
        <MemoryRouter>
          <RunDetails recipe={recipe} />
        </MemoryRouter>
      </StreamContext>
    </QueryClientProvider>,
  )
}

test('a lead-decides run folds its spend, limits and team under "Run details"', async () => {
  mount({ kind: 'orchestration', ref: 'orch-1' })
  const section = screen.getByLabelText('Run details')
  expect(within(section).getByText('Run details')).toBeTruthy()
  // Folded by default: the details element is not open until the person opens it.
  expect((section as HTMLDetailsElement).open).toBe(false)
  expect(await within(section).findByLabelText('Spend')).toBeTruthy()
  expect(within(section).getByLabelText('Limits')).toBeTruthy()
  expect(within(section).getByLabelText('Team on this run')).toBeTruthy()
})

test('a recipe run folds its spend, limits and inputs under "Run details"', async () => {
  mount({ kind: 'workflow', ref: 'wfrun-1' })
  const section = screen.getByLabelText('Run details')
  expect((section as HTMLDetailsElement).open).toBe(false)
  expect(await within(section).findByLabelText('Spend')).toBeTruthy()
  expect(within(section).getByLabelText('Limits')).toBeTruthy()
  expect(within(section).getByLabelText('Inputs')).toBeTruthy()
})
