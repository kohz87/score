import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'
import { renderDirect, resetDirectChatTest, stub } from './DirectChat-test-helpers.tsx'

afterEach(resetDirectChatTest)

test('the agent’s earlier chats are topics of one conversation, oldest first, each opened by a divider', async () => {
  stub()
  const { container } = renderDirect()
  await screen.findByText('Sockets go both ways.')
  const order = [...container.querySelectorAll('.bold-topic-divider, .bold-message')].map((node) =>
    node.classList.contains('bold-topic-divider')
      ? `divider:${node.getAttribute('data-topic-id')}`
      : node.getAttribute('data-message-id'),
  )
  expect(order).toEqual([
    'divider:chat-old',
    'old-question',
    'old-answer',
    'divider:chat-new',
    'question',
    'answer',
  ])
  const divider = container.querySelector('[data-topic-id="chat-old"]')!
  expect(divider.textContent).toContain('Topic · The cursor bug · done')
  expect(screen.getByPlaceholderText('Message builder privately')).toBeTruthy()
})

test('the composer writes to the newest open chat and says so under the box', async () => {
  const posts = stub()
  renderDirect('?with=builder')
  await screen.findByText('Sockets go both ways.')
  const bar = await screen.findByLabelText('Where this message goes')
  expect(bar.textContent).toContain('To builder')
  expect(bar.textContent).toContain('in Websockets or server-sent events')
  fireEvent.change(screen.getByPlaceholderText('Message builder privately'), {
    target: { value: 'And long polling?' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  await waitFor(() =>
    expect(posts.find((post) => post.url === '/api/rooms/direct-builder/messages')).toBeDefined(),
  )
  expect(
    posts.find((post) => post.url === '/api/rooms/direct-builder/messages')?.body,
  ).toMatchObject({ jobId: 'chat-new', text: 'And long polling?' })
})

test('a chat picked in the address (an old chat link) becomes the current one', async () => {
  const posts = stub()
  renderDirect('?with=builder&chat=chat-old')
  await screen.findByText('Sockets go both ways.')
  const bar = await screen.findByLabelText('Where this message goes')
  expect(bar.textContent).toContain('in The cursor bug')
  fireEvent.change(screen.getByPlaceholderText('Message builder privately'), {
    target: { value: 'One more thing' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  await waitFor(() =>
    expect(posts.find((post) => post.url === '/api/rooms/direct-builder/messages')).toBeDefined(),
  )
  expect(
    posts.find((post) => post.url === '/api/rooms/direct-builder/messages')?.body,
  ).toMatchObject({ jobId: 'chat-old' })
})

test('the / palette offers the chat commands that fit a one-to-one, and /new starts a new chat', async () => {
  const posts = stub()
  renderDirect()
  await screen.findByText('Sockets go both ways.')
  const box = screen.getByPlaceholderText('Message builder privately')
  fireEvent.change(box, { target: { value: '/' } })
  const list = await screen.findByRole('listbox', { name: 'Commands' })
  const names = within(list)
    .getAllByRole('option')
    .map((option) => option.textContent ?? '')
  expect(names.some((name) => name.startsWith('/new'))).toBe(true)
  expect(names.some((name) => name.startsWith('/rename'))).toBe(true)
  expect(names.some((name) => name.startsWith('/done'))).toBe(true)
  expect(names.some((name) => name.startsWith('/reopen'))).toBe(true)
  // Nothing about owners, members or a room workspace in a one-to-one.
  for (const gone of ['/lead', '/add', '/remove', '/workspace'])
    expect(names.some((name) => name.startsWith(gone))).toBe(false)
  fireEvent.change(box, { target: { value: '/new Long polling' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  await waitFor(() =>
    expect(posts.find((post) => post.url === '/api/agents/builder/chats')).toBeDefined(),
  )
  expect(posts.find((post) => post.url === '/api/agents/builder/chats')?.body).toEqual({
    title: 'Long polling',
  })
  expect((await screen.findByText(/You started the chat/)).textContent).toContain('New chat')
})

test('an unknown chat id keeps the conversation and says so', async () => {
  stub()
  renderDirect('?with=builder&chat=gone')
  expect((await screen.findByText('That chat isn’t here any more.')).getAttribute('role')).toBe(
    'status',
  )
  await screen.findByText('Sockets go both ways.')
})
