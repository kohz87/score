import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { AgentDetail } from '@score/contract'
import { createQueryClient } from '../../data/query-client.ts'
import { AgentUsage } from '../knowledge/AgentUsage.tsx'
import { KnowledgeToolsRow } from './KnowledgeToolsRow.tsx'

const agent = { id: 'builder', name: 'Builder' } as AgentDetail
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
let calls: { url: string; method: string; body: unknown }[]
let enabled: boolean
let usage: { agentId: string; writesToday: number }[]

function mount(node: React.ReactNode) {
  const queryClient = createQueryClient()
  queryClient.setDefaultOptions({ queries: { retry: false } })
  render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>)
}

beforeEach(() => {
  calls = []
  enabled = true
  usage = []
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const body = init?.body ? (JSON.parse(String(init.body)) as { enabled: boolean }) : undefined
      calls.push({ url, method: init?.method ?? 'GET', body })
      if (url === '/api/agents/builder/knowledge') {
        if (body) enabled = body.enabled
        return Promise.resolve(json({ enabled }))
      }
      if (url === '/api/knowledge/agent-usage') return Promise.resolve(json({ items: usage }))
      return Promise.resolve(json({ error: { code: 'not_found', message: 'x' } }, 404))
    }),
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

test('the Knowledge tools switch reflects and changes the per-agent setting', async () => {
  mount(<KnowledgeToolsRow agent={agent} />)
  const toggle = await screen.findByRole('switch', { name: 'Knowledge tools enabled for Builder' })
  await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'))
  fireEvent.click(toggle)
  await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'))
  expect(calls.find((c) => c.method === 'PUT')).toMatchObject({
    url: '/api/agents/builder/knowledge',
    body: { enabled: false },
  })
})

test('the switch is hidden when the server has no knowledge vault', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(json({ error: { code: 'not_found', message: 'x' } }, 404))),
  )
  mount(<KnowledgeToolsRow agent={agent} />)
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(screen.queryByRole('switch')).toBeNull()
})

test('Settings › Knowledge lists each agent’s writes today', async () => {
  usage = [
    { agentId: 'builder', writesToday: 7 },
    { agentId: 'reviewer', writesToday: 1 },
  ]
  mount(<AgentUsage />)
  expect(await screen.findByText('Agent writes today')).toBeDefined()
  expect(screen.getByText('builder').nextSibling?.textContent).toBe('7 writes')
  expect(screen.getByText('reviewer').nextSibling?.textContent).toBe('1 write')
})

test('nothing is shown while no agent has written today', async () => {
  mount(<AgentUsage />)
  await waitFor(() => expect(calls.length).toBe(1))
  expect(screen.queryByText('Agent writes today')).toBeNull()
})
