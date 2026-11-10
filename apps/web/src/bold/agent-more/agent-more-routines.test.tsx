import { fireEvent, screen, waitFor } from '@testing-library/react'
import { expect, test } from 'vitest'
import { ChannelsCard } from './ChannelsCard.tsx'
import { PluginsCard } from './PluginsCard.tsx'
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

test('Plugins toggle, and a locked one stays on', async () => {
  mount(<PluginsCard agent={agent} />)
  fireEvent.click(await screen.findByRole('checkbox', { name: /Extra/ }))
  await waitFor(() =>
    expect(sent('PATCH', '/settings/plugins/extra')?.body).toEqual({ enabled: true }),
  )
  expect(
    (screen.getByRole('checkbox', { name: /Score bridge/ }) as HTMLInputElement).disabled,
  ).toBe(true)
})

test('Channels show the state and open the setup for one that is not connected', async () => {
  mount(<ChannelsCard agent={agent} />)
  expect(await screen.findByText('Connected')).toBeDefined()
  expect(screen.queryByRole('button', { name: 'Connect Slack' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Connect Telegram' }))
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Connect Telegram' })).toBeNull())
})
