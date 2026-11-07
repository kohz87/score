import { fireEvent, screen, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { DeleteCard } from './DeleteCard.tsx'
import { LooksCard } from './LooksCard.tsx'
import { NameCard } from './NameCard.tsx'
import {
  agent,
  initialMemory,
  setUpAgentMoreTests,
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

test('Delete only asks the page to open its Remove panel', () => {
  const onDelete = vi.fn()
  mount(<DeleteCard agent={agent} onDelete={onDelete} />)
  expect(screen.getByText(/A private export is kept first/)).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: 'Delete agent' }))
  expect(onDelete).toHaveBeenCalledTimes(1)
  expect(calls).toHaveLength(0)
})

test('Looks offers the colour and shape picker', async () => {
  mount(<LooksCard agent={agent} />)
  fireEvent.click(screen.getByRole('button', { name: /Change builder.s colour and shape/ }))
  expect(await screen.findByRole('dialog', { name: 'Agent appearance' })).toBeDefined()
})

test('Name and role save through the agent endpoint', async () => {
  mount(<NameCard agent={agent} />)
  fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Builder One' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save details' }))
  await waitFor(() =>
    expect(sent('PATCH', '/agents/builder')?.body).toEqual({
      name: 'Builder One',
      role: 'Builds features',
    }),
  )
  expect(await screen.findByText('Details saved.')).toBeDefined()
})

test('failures show the server’s own message', async () => {
  override = (path, method) =>
    method === 'PATCH' && path === '/api/agents/builder'
      ? Response.json(
          { error: { code: 'conflict', message: 'That name is taken.' } },
          { status: 409 },
        )
      : null
  mount(<NameCard agent={agent} />)
  fireEvent.click(screen.getByRole('button', { name: 'Save details' }))
  expect(await screen.findByText('That name is taken.')).toBeDefined()
})
