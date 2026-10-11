import type { AgentSummary } from '@score/contract'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { NewRoomDialog } from './NewRoomDialog.tsx'

const agent = (id: string, name: string) =>
  ({
    id,
    name,
    role: '',
    state: 'idle',
    style: { color: '#6B4EFF', shape: 'hexagon' },
  }) as unknown as AgentSummary

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

test('creates a room with the lead as a member and opens it', async () => {
  const bodies: unknown[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)))
      return new Response(
        JSON.stringify({
          id: 'r1',
          name: '#launch',
          kind: 'room',
          leadAgentId: 'lead',
          members: ['lead', 'builder'],
          unread: 0,
          activeAgents: [],
          channels: [],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }),
  )
  const created = vi.fn()
  render(
    <NewRoomDialog
      agents={[agent('lead', 'Lead'), agent('builder', 'Builder'), agent('reviewer', 'Reviewer')]}
      close={() => undefined}
      created={created}
    />,
  )
  const create = screen.getByRole('button', { name: 'Create room' }) as HTMLButtonElement
  expect(create.disabled).toBe(true)
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Launch Plan' } })
  expect(screen.getByText(/Use lowercase letters, numbers and dashes/)).toBeTruthy()
  expect(create.disabled).toBe(true)
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'launch' } })
  fireEvent.click(screen.getByRole('checkbox', { name: /Builder/ }))
  expect(screen.queryByRole('checkbox', { name: /Lead/ })).toBeNull()
  fireEvent.click(create)
  await waitFor(() => expect(created).toHaveBeenCalled())
  expect(bodies[0]).toEqual({ name: 'launch', leadAgentId: 'lead', members: ['lead', 'builder'] })
})
