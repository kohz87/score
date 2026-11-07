import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { expect, test } from 'vitest'
import { RemembersCard } from './RemembersCard.tsx'
import {
  agent,
  at,
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

test('Remembers lists memories, forgets one and adds one', async () => {
  mount(<RemembersCard agent={agent} />)
  expect(await screen.findByText('Prefers small commits')).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: 'Forget: Prefers small commits' }))
  // Forgetting asks first (3.1.0); nothing is sent until it is confirmed.
  expect(sent('DELETE', '/memory/m1')).toBeUndefined()
  fireEvent.click(
    within(screen.getByRole('group', { name: 'Remove memory' })).getByRole('button', {
      name: 'Remove',
    }),
  )
  await waitFor(() => expect(sent('DELETE', '/memory/m1')).toBeDefined())
  fireEvent.change(screen.getByLabelText('New memory'), { target: { value: 'Use pnpm' } })
  fireEvent.click(screen.getByRole('button', { name: 'Add' }))
  await waitFor(() => expect(sent('POST', '/memory')?.body).toEqual({ text: 'Use pnpm' }))
  expect(await screen.findByText('Use pnpm')).toBeDefined()
})

test('Remembers searches as you type with matches marked, and a cancelled forget sends nothing', async () => {
  memory = [
    { id: 'm1', text: 'Prefers small commits', source: 'you', at },
    { id: 'm3', text: 'Deploys on Fridays', source: 'you', at },
  ]
  mount(<RemembersCard agent={agent} />)
  expect(await screen.findByText('Deploys on Fridays')).toBeDefined()
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search memory' }), {
    target: { value: 'COMMIT' },
  })
  expect(screen.queryByText('Deploys on Fridays')).toBeNull()
  expect(document.querySelector('mark')?.textContent).toBe('commit')
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search memory' }), {
    target: { value: 'zzz' },
  })
  expect(screen.getByText('No memories match “zzz”.')).toBeDefined()
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search memory' }), {
    target: { value: '' },
  })
  fireEvent.click(await screen.findByRole('button', { name: 'Forget: Deploys on Fridays' }))
  const confirm = screen.getByRole('group', { name: 'Remove memory' })
  expect(confirm.getAttribute('data-protected')).toBe('block')
  fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }))
  expect(screen.queryByRole('group', { name: 'Remove memory' })).toBeNull()
  expect(sent('DELETE', '/memory/m3')).toBeUndefined()
})
