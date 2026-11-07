import type { AgentDetail } from '@score/contract'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { expect, test } from 'vitest'
import { GoAheadCard } from './GoAheadCard.tsx'
import { NeverCard } from './NeverCard.tsx'
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

test('Never rules list, add one, and are a protected surface', async () => {
  mount(<NeverCard agent={agent} />)
  const card = screen.getByRole('region', { name: /Never rules/ })
  expect(card.getAttribute('data-protected')).toBe('block')
  expect(within(card).getByText('rm -rf *')).toBeDefined()
  fireEvent.change(within(card).getByLabelText('Never allow commands that match'), {
    target: { value: '*git* push*' },
  })
  fireEvent.click(within(card).getByRole('button', { name: 'Add' }))
  await waitFor(() =>
    expect(sent('PATCH', '/permissions/never%3A*git*%20push*')?.body).toEqual({ level: 'never' }),
  )
})

test('Goes ahead without asking can take a standing grant back, and a team rule is used again', async () => {
  const granted: AgentDetail = {
    ...agent,
    permissions: [
      { id: 'push code', label: 'Pushing code', level: 'allowed', inherited: false },
      { id: 'install packages', label: 'Installing packages', level: 'asks', inherited: false },
    ],
  }
  override = (path, method) =>
    path.endsWith('/settings/rules') && method === 'GET'
      ? Response.json({
          mode: 'smart',
          goAhead: [
            {
              id: 'install packages',
              label: 'Installing packages',
              pattern: null,
              readOnly: false,
            },
          ],
          askMe: [],
          never: [],
          drift: [],
        })
      : null
  mount(<GoAheadCard agent={granted} />)
  const card = screen.getByRole('region', { name: /Goes ahead without asking/ })
  expect(card.getAttribute('data-protected')).toBe('block')
  fireEvent.click(within(card).getByRole('button', { name: 'Ask first before: Pushing code' }))
  await waitFor(() =>
    expect(sent('PATCH', '/permissions/push%20code')?.body).toEqual({ level: 'asks' }),
  )
  fireEvent.click(
    await within(card).findByRole('button', { name: 'Use team rule: Installing packages' }),
  )
  await waitFor(() => expect(sent('DELETE', '/permissions/install%20packages')).toBeDefined())
})

test('Never: an own rule goes back to the team rule', async () => {
  mount(<NeverCard agent={agent} />)
  fireEvent.click(screen.getByRole('button', { name: 'Use team rule instead of: rm -rf *' }))
  await waitFor(() => expect(sent('DELETE', '/permissions/never%3Arm%20-rf%20*')).toBeDefined())
  expect(screen.queryByRole('button', { name: /instead of: sudo/ })).toBeNull()
})
