import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { expect, test } from 'vitest'
import { ScoreAccessCard } from './ScoreAccessCard.tsx'
import {
  agent,
  at,
  initialMemory,
  mcp,
  setUpAgentMoreTests,
  token,
  type Call,
  type Memory,
  type Override,
} from './agent-more-helpers.tsx'

let calls: Call[] = []
let override: Override | null = null
let memory: Memory[] = initialMemory()
const { mount, sent } = setUpAgentMoreTests({
  calls: () => calls,
  override: () => override,
  memory: () => memory,
  setMemory: (next) => {
    memory = next
  },
  reset: () => {
    calls = []
    override = null
    memory = initialMemory()
  },
})

test('Score access switches read access and creates no key by itself', async () => {
  mount(<ScoreAccessCard agent={agent} />)
  const card = await screen.findByRole('region', { name: 'Score access' })
  expect(card.getAttribute('data-protected')).toBe('flex')
  fireEvent.click(await within(card).findByRole('checkbox', { name: /Read rooms/ }))
  await waitFor(() => expect(sent('PUT', '/mcp')?.body).toEqual({ enabled: true }))
  expect(calls.some((call) => call.path.endsWith('/mcp/token'))).toBe(false)
})

test('Score access: a key is shown once, replaced, revoked, and Write too toggles', async () => {
  override = (path, method, body) => {
    if (path.endsWith('/mcp/token') && method === 'POST')
      return Response.json({
        token,
        access: { ...mcp, enabled: true, hasToken: true, tokenCreatedAt: at },
      })
    if (path.endsWith('/mcp/token') && method === 'DELETE')
      return Response.json({ ...mcp, enabled: true, hasToken: false })
    if (path.endsWith('/mcp') && method === 'PUT')
      return Response.json({ ...mcp, enabled: true, hasToken: true, ...(body as object) })
    if (path.endsWith('/mcp') && method === 'GET')
      return Response.json({ ...mcp, enabled: true, hasToken: false })
    return null
  }
  mount(<ScoreAccessCard agent={agent} />)
  const card = await screen.findByRole('region', { name: 'Score access' })
  fireEvent.click(await within(card).findByRole('button', { name: 'Create key' }))
  expect(await within(card).findByText(token)).toBeDefined()
  expect(sent('POST', '/mcp/token')).toBeDefined()
  fireEvent.click(within(card).getByRole('checkbox', { name: /Write too/ }))
  await waitFor(() => expect(sent('PUT', '/mcp')?.body).toEqual({ writesEnabled: true }))
  fireEvent.click(await within(card).findByRole('button', { name: 'Revoke' }))
  await waitFor(() => expect(sent('DELETE', '/mcp/token')).toBeDefined())
  await waitFor(() => expect(within(card).queryByText(token)).toBeNull())
})

test('Score access: replacing a key asks first, since the old one stops working (3.13.2)', async () => {
  override = (path, method) => {
    if (path.endsWith('/mcp/token') && method === 'POST')
      return Response.json({
        token,
        access: { ...mcp, enabled: true, hasToken: true, tokenCreatedAt: at },
      })
    if (path.endsWith('/mcp') && method === 'GET')
      return Response.json({ ...mcp, enabled: true, hasToken: true, tokenCreatedAt: at })
    return null
  }
  mount(<ScoreAccessCard agent={agent} />)
  const card = await screen.findByRole('region', { name: 'Score access' })
  fireEvent.click(await within(card).findByRole('button', { name: 'Replace key' }))
  const warning = await within(card).findByRole('alert')
  expect(warning.textContent).toMatch(/stops working at once/)
  expect(sent('POST', '/mcp/token')).toBeUndefined()
  fireEvent.click(within(warning).getByRole('button', { name: 'Cancel' }))
  expect(within(card).queryByRole('alert')).toBeNull()
  expect(sent('POST', '/mcp/token')).toBeUndefined()
  fireEvent.click(within(card).getByRole('button', { name: 'Replace key' }))
  fireEvent.click(
    within(await within(card).findByRole('alert')).getByRole('button', { name: 'Replace key' }),
  )
  expect(await within(card).findByText(token)).toBeDefined()
  // The setup note names the command that clears the old key from the profile.
  expect(within(card).getByTestId('mcp-rotate-note').textContent).toMatch(
    /config unset MCP_SCORE_API_KEY/,
  )
})

test('Score access offers Reload MCP once access and a key are set up, and says when Hermes refused (3.7.9)', async () => {
  let refuse = true
  override = (path, method) => {
    if (path.endsWith('/mcp') && method === 'GET')
      return Response.json({ ...mcp, enabled: true, hasToken: true, tokenCreatedAt: at })
    if (path.endsWith('/mcp/reload') && method === 'POST')
      return refuse
        ? Response.json(
            { error: { code: 'agent_busy', message: 'It is working right now.' } },
            { status: 409 },
          )
        : Response.json({ agentId: agent.id, scope: 'profile' })
    return null
  }
  mount(<ScoreAccessCard agent={agent} />)
  const card = await screen.findByRole('region', { name: 'Score access' })
  fireEvent.click(await within(card).findByRole('button', { name: 'Reload MCP' }))
  // The question takes the focus; Cancel gives it back to the button.
  await waitFor(() =>
    expect(document.activeElement).toBe(
      within(card).getByRole('button', { name: 'Restart and reload' }),
    ),
  )
  fireEvent.click(within(card).getByRole('button', { name: 'Cancel' }))
  await waitFor(() =>
    expect(document.activeElement).toBe(within(card).getByRole('button', { name: 'Reload MCP' })),
  )
  fireEvent.click(within(card).getByRole('button', { name: 'Reload MCP' }))
  fireEvent.click(within(card).getByRole('button', { name: 'Restart and reload' }))
  expect(await within(card).findByRole('alert')).toHaveProperty(
    'textContent',
    'It is working right now.',
  )
  refuse = false
  fireEvent.click(within(card).getByRole('button', { name: 'Reload MCP' }))
  fireEvent.click(within(card).getByRole('button', { name: 'Restart and reload' }))
  expect(await within(card).findByText('Reloaded.')).toBeDefined()
})

test('Score access keeps the card with a retry when it cannot load', async () => {
  let fail = true
  override = (path, method) =>
    path.endsWith('/mcp') && method === 'GET' && fail
      ? Response.json({ error: { code: 'unavailable', message: 'MCP is down.' } }, { status: 500 })
      : null
  mount(<ScoreAccessCard agent={agent} />)
  const card = await screen.findByRole('region', { name: 'Score access' })
  expect(await within(card).findByText(/MCP is down\./)).toBeDefined()
  expect(card.getAttribute('data-protected')).toBe('flex')
  fail = false
  fireEvent.click(within(card).getByRole('button', { name: 'Try again' }))
  expect(await within(card).findByRole('checkbox', { name: /Read rooms/ })).toBeDefined()
})
