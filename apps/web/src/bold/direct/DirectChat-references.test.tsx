import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'
import { renderDirect, resetDirectChatTest, stub } from './DirectChat-test-helpers.tsx'

afterEach(resetDirectChatTest)

test('a chat’s latest reply can be shared or brought into a new chat', async () => {
  stub()
  renderDirect()
  await screen.findByText('Sockets go both ways.')
  // Share is offered on a reply; Bring into a new chat only on the latest one.
  expect(screen.getAllByRole('button', { name: /^Share message from builder/ })).toHaveLength(2)
  expect(screen.getAllByRole('button', { name: 'Bring into a new chat' })).toHaveLength(1)
})

test('Bring into a new chat opens an empty chat that refers to the one it came from', async () => {
  stub()
  const { container } = renderDirect()
  fireEvent.click(await screen.findByRole('button', { name: 'Bring into a new chat' }))
  expect(await screen.findByRole('heading', { name: 'New chat with builder' })).toBeTruthy()
  expect(container.querySelector('.bold-dm-ref')?.textContent).toContain(
    'Referring to Websockets or server-sent events',
  )
})

test('"Take it aside": the first message makes the chat, carrying the reference', async () => {
  const posts = stub()
  renderDirect('?with=builder&ref=team-job')
  expect(await screen.findByRole('heading', { name: 'New chat with builder' })).toBeTruthy()
  expect(document.querySelector('.bold-dm-ref')?.textContent).toContain(
    'Referring to Release notes 2.4',
  )
  fireEvent.change(screen.getByPlaceholderText('Message builder privately'), {
    target: { value: 'Can you take this?' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  await waitFor(() =>
    expect(posts.find((post) => post.url === '/api/rooms/direct-builder/messages')).toBeDefined(),
  )
  expect(posts[0]).toMatchObject({
    url: '/api/agents/builder/chats',
    body: { title: 'Release notes 2.4' },
  })
  expect(
    posts.find((post) => post.url === '/api/rooms/direct-builder/messages')?.body,
  ).toMatchObject({ jobId: 'chat-made', refs: [{ jobId: 'team-job' }] })
})

test('the reference chip can be removed', async () => {
  stub()
  renderDirect('?with=builder&chat=chat-new&ref=team-job')
  await screen.findByText(/Referring to/)
  fireEvent.click(screen.getByRole('button', { name: 'Remove reference' }))
  await waitFor(() => expect(screen.queryByText(/Referring to/)).toBeNull())
})
