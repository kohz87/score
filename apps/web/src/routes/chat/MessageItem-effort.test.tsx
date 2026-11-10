import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, expect, test } from 'vitest'
import { agents, makeMessage } from '../../bold/room/room-test-utils.tsx'
import { MessageItem } from './MessageItem.tsx'

afterEach(cleanup)

/** Decision 178, part 7: an agent's reply names the effort it ran at, when the chat set one. */
const reply = (effort?: string | null) =>
  makeMessage({
    id: 'reply-1',
    author: { kind: 'agent', agentId: 'builder' },
    parts: [{ kind: 'text', text: 'On it.' }],
    ...(effort === undefined ? {} : { effort }),
  })

test('a reply that ran at a chat effort says so in its name line', () => {
  render(
    <MemoryRouter>
      <MessageItem message={reply('high')} agents={agents} bold />
    </MemoryRouter>,
  )
  expect(screen.getByText('· effort high')).toBeTruthy()
})

test('a reply with no chat effort shows no effort label', () => {
  render(
    <MemoryRouter>
      <MessageItem message={reply(null)} agents={agents} bold />
    </MemoryRouter>,
  )
  expect(screen.queryByText(/· effort/)).toBeNull()
})

test('the classic view shows no chat effort on a reply, even one that carries it', () => {
  render(
    <MemoryRouter>
      <MessageItem message={reply('high')} agents={agents} />
    </MemoryRouter>,
  )
  expect(screen.queryByText(/· effort/)).toBeNull()
})
