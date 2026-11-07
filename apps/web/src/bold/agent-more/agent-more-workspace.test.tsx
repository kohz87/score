import { fireEvent, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { WorkspaceCard } from './WorkspaceCard.tsx'
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

test('Workspace shows the newest files first and opens one', async () => {
  const onOpen = vi.fn()
  mount(<WorkspaceCard agent={agent} onOpen={onOpen} />)
  const first = await screen.findByRole('button', { name: /events\.py/ })
  expect(screen.getByText(/Branch main · 2 files changed/)).toBeDefined()
  fireEvent.click(first)
  expect(onOpen).toHaveBeenCalledWith('events.py')
  fireEvent.click(screen.getByRole('button', { name: 'Browse all files' }))
  expect(onOpen).toHaveBeenLastCalledWith(null)
  // 3.20.0: the folder is read-only here; shared workspaces are set in Settings.
  expect(screen.queryByRole('button', { name: 'Set folder' })).toBeNull()
  expect(screen.queryByRole('textbox', { name: 'Folder on this computer' })).toBeNull()
  expect(
    screen
      .getByRole('link', { name: 'Workspaces are set in Settings › Workspaces' })
      .getAttribute('href'),
  ).toBe('/b/settings/workspaces')
})

test('3.20.0: neither a coding agent’s nor a Hermes agent’s folder can be changed from the agent page', async () => {
  mount(
    <WorkspaceCard agent={{ ...agent, id: 'coder', runtime: 'claude-code' }} onOpen={vi.fn()} />,
  )
  await screen.findByRole('link', { name: /Settings › Workspaces/ })
  expect(screen.queryByRole('button', { name: 'Set folder' })).toBeNull()
  expect(sent('PATCH', '/coding-agents/coder')).toBeUndefined()
  expect(sent('PUT', '/workspace/root')).toBeUndefined()
})
