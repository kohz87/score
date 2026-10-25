import { expect, test } from 'vitest'
import { agents } from './room/room-test-utils.tsx'
import { agentDisplayName, agentStateLabel } from './bold-agents.ts'

test('agents are named by their display name, falling back to their id', () => {
  expect(agentDisplayName(agents[0]!)).toBe('lead')
  expect(agentDisplayName({ id: 'profile-7', name: '' })).toBe('profile-7')
})

test('one helper words every agent state', () => {
  expect(agentStateLabel(agents[0]!)).toBe('free')
  expect(agentStateLabel(agents[1]!)).toBe('working')
  expect(agentStateLabel({ ...agents[0]!, status: 'waiting' })).toBe('needs you')
  expect(agentStateLabel({ ...agents[0]!, status: 'up-next' })).toBe('up next')
})
