import { fireEvent, screen, waitFor } from '@testing-library/react'
import type { AgentDetail, AgentSubagents, AgentSubagentsRequest } from '@score/contract'
import { afterEach, expect, test, vi } from 'vitest'
import { disposeRoomTest, jsonResponse, renderInRoom } from '../room/room-test-utils.tsx'
import { SubagentsCard } from './SubagentsCard.tsx'

/** SA.3 part 10: the agent's subagent ceiling on its More page. */
afterEach(() => {
  disposeRoomTest()
  vi.unstubAllGlobals()
})

const lead = { id: 'lead', name: 'lead' } as unknown as AgentDetail

const ceiling = (over: Partial<AgentSubagents> = {}): AgentSubagents => ({
  agentId: 'lead',
  control: 'limits',
  enabled: true,
  maxConcurrent: 4,
  model: null,
  maxIterations: 50,
  timeoutSeconds: null,
  ...over,
})

function stub(agent: AgentSubagents) {
  const puts: AgentSubagentsRequest[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as AgentSubagentsRequest
        puts.push(body)
        return jsonResponse({ ...agent, ...body, model: body.model ?? null })
      }
      return jsonResponse(agent)
    }),
  )
  return puts
}

test('Hermes (limits): the mock-up’s fields, filled from the agent’s own settings', async () => {
  stub(ceiling())
  renderInRoom(<SubagentsCard agent={lead} />)
  expect(await screen.findByLabelText('At once')).toHaveProperty('value', '4')
  expect(screen.getByLabelText('Model')).toHaveProperty('value', '')
  expect(screen.getByLabelText('Model').getAttribute('placeholder')).toBe('Same as lead')
  expect(screen.getByLabelText('Steps for each')).toHaveProperty('value', '50')
  expect(screen.getByLabelText(/Time for each/)).toHaveProperty('value', '')
  expect(screen.getByLabelText('Allow subagents')).toHaveProperty('checked', true)
})

test('saving sends the whole ceiling; a blank time is no limit (null) and a blank model is the agent’s own', async () => {
  const puts = stub(ceiling())
  renderInRoom(<SubagentsCard agent={lead} />)
  await screen.findByLabelText('At once')
  fireEvent.change(screen.getByLabelText('At once'), { target: { value: '2' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(puts).toHaveLength(1))
  expect(puts[0]).toEqual({
    enabled: true,
    maxConcurrent: 2,
    model: null,
    maxIterations: 50,
    timeoutSeconds: null,
  })
})

test('a time in minutes is sent as seconds', async () => {
  const puts = stub(ceiling())
  renderInRoom(<SubagentsCard agent={lead} />)
  await screen.findByLabelText('At once')
  fireEvent.change(screen.getByLabelText(/Time for each/), { target: { value: '5' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(puts).toHaveLength(1))
  expect(puts[0]?.timeoutSeconds).toBe(300)
})

test('an at-once number above the contract’s limit can’t be saved', async () => {
  const puts = stub(ceiling())
  renderInRoom(<SubagentsCard agent={lead} />)
  await screen.findByLabelText('At once')
  fireEvent.change(screen.getByLabelText('At once'), { target: { value: '99' } })
  expect(screen.getByLabelText('At once').getAttribute('aria-invalid')).toBe('true')
  expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true)
  expect(puts).toEqual([])
})

test('Claude Code (on_off): the on/off line only, and it saves only Allow subagents', async () => {
  const puts = stub(ceiling({ control: 'on_off' }))
  renderInRoom(<SubagentsCard agent={lead} />)
  expect(await screen.findByText(/Claude Code decides how many run at once/)).toBeTruthy()
  expect(screen.queryByLabelText('At once')).toBeNull()
  fireEvent.click(screen.getByLabelText('Allow subagents'))
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(puts).toHaveLength(1))
  expect(puts[0]).toEqual({ enabled: false })
})

test('Codex (none): says it isn’t supported and offers no form', async () => {
  stub(ceiling({ control: 'none', maxConcurrent: 1 }))
  renderInRoom(<SubagentsCard agent={lead} />)
  expect(await screen.findByText('Subagents aren’t supported here yet')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
})
