import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, expect, test } from 'vitest'
import { agents, makeMessage } from '../../bold/room/room-test-utils.tsx'
import { MessageItem } from './MessageItem.tsx'

afterEach(cleanup)

/** Decision 182: an agent's reply names the model its turn was asked to run on, when it wasn't the agent's own. */
const reply = (extra: object) =>
  makeMessage({
    id: 'reply-1',
    author: { kind: 'agent', agentId: 'builder' },
    parts: [{ kind: 'text', text: 'On it.' }],
    ...extra,
  })
const view = (message: ReturnType<typeof reply>, bold = true) =>
  render(
    <MemoryRouter>
      <MessageItem message={message} agents={agents} bold={bold} />
    </MemoryRouter>,
  )

test('the name line reads "agent · model · effort level", each part only when present', () => {
  view(reply({ model: 'example-large', effort: 'high' }))
  const line = document.querySelector('.chat-message-meta')!.textContent
  expect(line).toMatch(/builder.*· example-large.*· effort high/)
})

test('a model alone, and neither, read cleanly', () => {
  const { unmount } = view(reply({ model: 'example-large' }))
  expect(screen.getByText('· example-large')).toBeTruthy()
  expect(screen.queryByText(/· effort/)).toBeNull()
  unmount()
  view(reply({}))
  expect(document.querySelector('.bold-reply-model')).toBeNull()
})

test('the classic view shows no model on a reply, even one that carries it', () => {
  view(reply({ model: 'example-large' }), false)
  expect(screen.queryByText('· example-large')).toBeNull()
})
