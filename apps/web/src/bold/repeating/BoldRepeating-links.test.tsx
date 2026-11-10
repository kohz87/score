import type { AgentDetail } from '@score/contract'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { expect, test } from 'vitest'
import { AssignedTile } from '../agent-page/AssignedTile.tsx'
import { job, mount, repeating as state, sent } from './repeating-helpers.tsx'

// The agent page's Assigned links do what they say (decision 183): the filter chip on, or the new-job panel open with
// the agent chosen.
const tile = [
  {
    path: '/b/agents/builder',
    element: <AssignedTile agent={{ id: 'builder' } as AgentDetail} />,
  },
]

function seed() {
  state.jobs = [job('b1', 'builder', { title: 'Morning summary' }), job('l1', 'lead')]
}

test('Open in Tasks lands on the list with that agent’s chip on', async () => {
  seed()
  mount('/b/agents/builder', tile)
  fireEvent.click(await screen.findByRole('link', { name: 'Open in Tasks' }))
  const chips = await screen.findByRole('group', { name: 'Assigned to' })
  await waitFor(() =>
    expect(
      within(chips).getByRole('button', { name: 'builder · 1' }).getAttribute('aria-pressed'),
    ).toBe('true'),
  )
  expect(screen.getByText('Morning summary')).toBeTruthy()
  expect(screen.queryByText('Job l1')).toBeNull()
})

test('Start a repeating job lands on the new-job panel with that agent assigned', async () => {
  seed()
  mount('/b/agents/builder', tile)
  fireEvent.click(await screen.findByRole('link', { name: 'Start a repeating job' }))
  const panel = await screen.findByRole('complementary', { name: 'New repeating job' })
  const who = within(panel).getByRole('radiogroup', { name: 'Assigned to' })
  expect(within(who).getByRole('radio', { name: 'builder' }).getAttribute('aria-checked')).toBe(
    'true',
  )
})

test('?new=1&agent= opens the panel for an agent with no jobs, on an empty list', async () => {
  mount('/b/tasks/repeating?new=1&agent=reviewer')
  const panel = await screen.findByRole('complementary', { name: 'New repeating job' })
  expect(
    within(within(panel).getByRole('radiogroup', { name: 'Assigned to' }))
      .getByRole('radio', { name: 'reviewer' })
      .getAttribute('aria-checked'),
  ).toBe('true')
  expect(sent('POST')).toHaveLength(0)
})
