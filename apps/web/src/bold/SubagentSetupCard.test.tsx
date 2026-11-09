import type { SubagentSetup, SubagentSetupAgent } from '@score/contract'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { SubagentSetupCard, subagentSetupKey } from './SubagentSetupCard.tsx'

const agentSetup = (agentId: string, inline: boolean, guard: boolean): SubagentSetupAgent => ({
  agentId,
  inline,
  guard,
})

let setup: SubagentSetup
let applyReply: (() => Response) | null
let applyBodies: string[]
const clients: QueryClient[] = []

const setupWith = (...agents: SubagentSetupAgent[]): SubagentSetup => ({ agents })

function open() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  clients.push(queryClient)
  render(
    <QueryClientProvider client={queryClient}>
      <SubagentSetupCard />
    </QueryClientProvider>,
  )
  return queryClient
}

beforeEach(() => {
  setup = setupWith()
  applyReply = null
  applyBodies = []
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), 'http://x').pathname
      if (path === '/api/subagent-setup') return Promise.resolve(Response.json(setup))
      if (path === '/api/subagent-setup/apply') {
        applyBodies.push(String(init?.body ?? ''))
        return Promise.resolve(applyReply ? applyReply() : Response.json(setup))
      }
      return Promise.resolve(
        Response.json({ error: { code: 'not_found', message: 'Not found.' } }, { status: 404 }),
      )
    }),
  )
})

afterEach(() => {
  cleanup()
  for (const queryClient of clients.splice(0)) queryClient.clear()
  vi.unstubAllGlobals()
})

test('shows nothing when every agent is already inline with its guard', async () => {
  setup = setupWith(agentSetup('builder', true, true), agentSetup('coder', true, true))
  const queryClient = open()
  await waitFor(() => expect(queryClient.getQueryState(subagentSetupKey)?.status).toBe('success'))
  expect(screen.queryByText(/agents? needs? one setting changed/)).toBeNull()
})

test('counts every non-inline agent and lists all their ids', async () => {
  setup = setupWith(
    agentSetup('builder', false, true),
    agentSetup('coder', false, false),
    agentSetup('lead', true, true),
  )
  open()

  expect(
    await screen.findByRole('heading', { name: '2 agents need one setting changed' }),
  ).toBeDefined()
  expect(screen.getByText('delegation.gateway_mode: inline · builder, coder')).toBeDefined()
  expect(screen.getByText('Waiting for the updated Score plugin: coder')).toBeDefined()
  expect(screen.getByRole('button', { name: 'Apply to all 1' })).toBeDefined()
})

test('Apply posts only agents with a guard and refreshes until the card shrinks', async () => {
  setup = setupWith(
    agentSetup('builder', false, true),
    agentSetup('coder', false, true),
    agentSetup('reviewer', false, false),
  )
  applyReply = () => {
    setup = setupWith(
      agentSetup('builder', true, true),
      agentSetup('coder', true, true),
      agentSetup('reviewer', false, false),
    )
    return Response.json(setup)
  }
  open()

  fireEvent.click(await screen.findByRole('button', { name: 'Apply to all 2' }))
  await waitFor(() => expect(applyBodies).toHaveLength(1))
  expect(JSON.parse(applyBodies[0]!)).toEqual({ agentIds: ['builder', 'coder'] })

  expect(
    await screen.findByRole('heading', { name: '1 agent needs one setting changed' }),
  ).toBeDefined()
  expect(screen.getByText('delegation.gateway_mode: inline · reviewer')).toBeDefined()
  expect(screen.getByText('Waiting for the updated Score plugin: reviewer')).toBeDefined()
  expect(screen.queryByRole('button', { name: /^Apply to all/ })).toBeNull()
})

test('shows the server message inside the card when Apply fails and keeps both buttons', async () => {
  setup = setupWith(agentSetup('builder', false, true))
  applyReply = () =>
    Response.json(
      {
        error: {
          code: 'conflict',
          message: 'builder needs the updated Score plugin first, so nothing was changed.',
        },
      },
      { status: 409 },
    )
  open()

  const apply = await screen.findByRole('button', { name: 'Apply to all 1' })
  fireEvent.click(apply)
  const alert = await screen.findByRole('alert')
  expect(alert.textContent).toBe(
    'builder needs the updated Score plugin first, so nothing was changed.',
  )
  expect(alert.className).toContain('bold-team-error')
  await waitFor(() => expect(apply.hasAttribute('disabled')).toBe(false))
  expect(screen.getByRole('button', { name: 'Apply to all 1' })).toBeDefined()
  expect(screen.getByRole('button', { name: 'Not now' })).toBeDefined()
})

test('an inline agent without its guard has no limits, so it is listed as waiting for the plugin', async () => {
  setup = setupWith(agentSetup('builder', true, true), agentSetup('coder', true, false))
  open()

  expect(
    await screen.findByRole('heading', { name: '1 agent needs one setting changed' }),
  ).toBeDefined()
  expect(screen.getByText('Waiting for the updated Score plugin: coder')).toBeDefined()
  expect(screen.queryByRole('button', { name: /^Apply to all/ })).toBeNull()
})

test('a failed Apply refreshes the card, so an agent that did change leaves the list', async () => {
  setup = setupWith(agentSetup('builder', false, true), agentSetup('coder', false, true))
  applyReply = () => {
    setup = setupWith(agentSetup('builder', true, true), agentSetup('coder', false, true))
    return Response.json(
      { error: { code: 'conflict', message: 'coder could not be changed.' } },
      { status: 409 },
    )
  }
  open()

  fireEvent.click(await screen.findByRole('button', { name: 'Apply to all 2' }))
  expect(await screen.findByRole('alert')).toBeDefined()
  expect(
    await screen.findByRole('heading', { name: '1 agent needs one setting changed' }),
  ).toBeDefined()
  expect(screen.getByRole('button', { name: 'Apply to all 1' })).toBeDefined()
  expect(screen.getByText('delegation.gateway_mode: inline · coder')).toBeDefined()
})

test('Not now hides the card for this visit', async () => {
  setup = setupWith(agentSetup('builder', false, true))
  open()

  expect(
    await screen.findByRole('heading', { name: '1 agent needs one setting changed' }),
  ).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
  expect(screen.queryByRole('heading', { name: '1 agent needs one setting changed' })).toBeNull()

  cleanup()
  open()
  expect(
    await screen.findByRole('heading', { name: '1 agent needs one setting changed' }),
  ).toBeDefined()
})

test('lists agents without a guard and leaves out Apply when none can be applied', async () => {
  setup = setupWith(agentSetup('builder', false, false), agentSetup('coder', false, false))
  open()

  expect(
    await screen.findByRole('heading', { name: '2 agents need one setting changed' }),
  ).toBeDefined()
  expect(screen.getByText('Waiting for the updated Score plugin: builder, coder')).toBeDefined()
  expect(screen.queryByRole('button', { name: /^Apply to all/ })).toBeNull()
  expect(screen.getByRole('button', { name: 'Not now' })).toBeDefined()
})
