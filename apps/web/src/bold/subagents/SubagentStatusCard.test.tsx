import { fireEvent, screen } from '@testing-library/react'
import type { SubagentRow } from '@score/contract'
import { afterEach, expect, test, vi } from 'vitest'
import { agents, disposeRoomTest, renderInRoom } from '../room/room-test-utils.tsx'
import { MediaWindow } from '../../data/use-media.ts'
import { MessageSubagentCard } from './MessageSubagentCard.tsx'

/** SA.3 part 2: the chat's status card under the parent's message. */
afterEach(() => {
  disposeRoomTest()
  vi.unstubAllGlobals()
})

const lead = agents.find((agent) => agent.id === 'lead')!

const row = (over: Partial<SubagentRow>): SubagentRow => ({
  id: 'sub-1',
  jobId: 'job-feed',
  agentId: 'lead',
  goal: 'Read the feed code',
  state: 'running',
  waitingOnYou: false,
  startedAt: '2026-11-09T01:00:00.000Z',
  endedAt: null,
  costUsd: null,
  tokens: null,
  ...over,
})

const rows: SubagentRow[] = [
  row({ id: 'a', goal: 'Read the feed code', state: 'done', endedAt: '2026-11-09T01:01:30.000Z' }),
  row({ id: 'b', goal: 'Check the query', state: 'running', waitingOnYou: true }),
]

// A phone: the card collapses to one button.
const phone = {
  matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
}

test('desktop: the title, each row’s state and goal, and a Details link for the agent', () => {
  renderInRoom(<MessageSubagentCard rows={rows} agents={agents} />)
  expect(screen.getByText('Subagents · 1 of 2 done')).toBeTruthy()
  expect(screen.getByText('Done')).toBeTruthy()
  expect(screen.getByText('Waiting')).toBeTruthy()
  expect(screen.getByText('Read the feed code')).toBeTruthy()
  expect(screen.getByText('needs you')).toBeTruthy()
  expect(screen.getByRole('link', { name: /Details: lead’s subagents in Watch/ })).toBeTruthy()
})

test('the card is named for its parent agent and draws no avatar of its own', () => {
  const { container } = renderInRoom(<MessageSubagentCard rows={rows} agents={agents} />)
  expect(screen.getByRole('region', { name: `${lead.name}’s subagents` })).toBeTruthy()
  // A subagent never has an avatar, an author line or a member chip: the card shows text rows only.
  expect(container.querySelector('img, [data-agent-glyph], .bold-avatar')).toBeNull()
})

test('no rows: nothing is drawn under the message', () => {
  const { container } = renderInRoom(<MessageSubagentCard rows={[]} agents={agents} />)
  expect(container.querySelector('.bold-subagent-card')).toBeNull()
  expect(container.textContent).toBe('')
})

test('a message that started no subagents has no card at all', () => {
  const { container } = renderInRoom(<MessageSubagentCard rows={undefined} agents={agents} />)
  expect(container.textContent).toBe('')
})

test('phone: one button with aria-expanded, and the rows open when tapped', () => {
  renderInRoom(
    <MediaWindow value={phone as unknown as Window}>
      <MessageSubagentCard rows={rows} agents={agents} />
    </MediaWindow>,
  )
  const toggle = screen.getByRole('button', { name: /Subagents · 1 of 2 done/ })
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  expect(screen.queryByText('Read the feed code')).toBeNull()
  fireEvent.click(toggle)
  expect(toggle.getAttribute('aria-expanded')).toBe('true')
  expect(screen.getByText('Check the query')).toBeTruthy()
  expect(screen.getByText('One is waiting for you')).toBeTruthy()
})
