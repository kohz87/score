import { fireEvent, screen, waitFor } from '@testing-library/react'
import { expect, test } from 'vitest'
import { CanUseCard } from './CanUseCard.tsx'
import { SkillsCard } from './SkillsCard.tsx'
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

test('Skills turn off and on, and the hub result is added', async () => {
  mount(<SkillsCard agent={agent} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Turn off planning' }))
  await waitFor(() => expect(sent('PATCH', '/skills/planning')?.body).toEqual({ enabled: false }))
  fireEvent.click(screen.getByRole('button', { name: 'Turn on sketching' }))
  await waitFor(() => expect(sent('PATCH', '/skills/sketching')?.body).toEqual({ enabled: true }))
  fireEvent.change(screen.getByLabelText('Find a skill'), { target: { value: 'writ' } })
  fireEvent.click(screen.getByRole('button', { name: 'Search' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Add writer' }))
  await waitFor(() => expect(sent('POST', '/skills')?.body).toEqual({ name: 'hub/writer' }))
})

test('Can use switches a tool, lists tool servers and links to Settings', async () => {
  mount(<CanUseCard agent={agent} coding={false} />)
  fireEvent.click(await screen.findByRole('checkbox', { name: 'Files' }))
  await waitFor(() => expect(sent('PATCH', '/tools/files')?.body).toEqual({ enabled: true }))
  expect(screen.getByText(/Tool servers: Search server/)).toBeDefined()
  expect(screen.getByRole('link', { name: 'Manage' }).getAttribute('href')).toBe(
    '/b/settings/tools',
  )
})
