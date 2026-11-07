import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'
import { agents, renderInRoom } from '../room/room-test-utils.tsx'
import { DirectChat } from './DirectChat.tsx'
import { builder, renderDirect, resetDirectChatTest, stub } from './DirectChat-test-helpers.tsx'
import { PrivacyNote } from './direct-parts.tsx'

afterEach(resetDirectChatTest)

test('the privacy label is a protected surface that names the agent', () => {
  renderInRoom(<PrivacyNote agent={builder} />)
  const label = screen.getByText('Only you and builder see this')
  expect(label.closest('[data-protected]')).not.toBeNull()
  expect(label.className).toContain('bold-dm-privacy')
})

test('the header shows the agent, "Direct · status", the privacy label and Chat info', async () => {
  stub()
  const { onToggleInfo } = renderDirect()
  await screen.findByText('Sockets go both ways.')
  const heading = await screen.findByRole('heading', { name: 'builder' })
  const bar = heading.closest('.bold-chat-bar')!
  expect(bar.textContent).toContain('Direct · working')
  expect(within(bar as HTMLElement).getByText('Only you and builder see this')).toBeTruthy()
  fireEvent.click(within(bar as HTMLElement).getByRole('button', { name: 'Chat info' }))
  expect(onToggleInfo).toHaveBeenCalled()
})

test('on a phone the chat bar has the same Back and Info as a group chat, and the open chat in its line', async () => {
  stub()
  const { onBackToChats, onChatInfo } = renderDirect('?with=builder&chat=chat-new', {
    phone: true,
  })
  await screen.findByText('Sockets go both ways.')
  const title = await screen.findByText('builder', { selector: '[data-phone-chat-title]' })
  const bar = title.closest('.bold-chat-phone-bar') as HTMLElement
  expect(bar.textContent).toContain('Websockets or server-sent events · Direct · working')
  expect(within(bar).getByText('Only you and builder see this')).toBeTruthy()
  fireEvent.click(within(bar).getByRole('button', { name: 'Back to chats' }))
  expect(onBackToChats).toHaveBeenCalled()
  fireEvent.click(within(bar).getByRole('button', { name: 'Chat info' }))
  expect(onChatInfo).toHaveBeenCalled()
})

test('with no chat room yet the home says it is just you and the agent, and a starter makes the first chat', async () => {
  const posts = stub([], undefined, null)
  renderDirect('?with=builder')
  expect(await screen.findByRole('heading', { name: 'Just you and builder' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'What are you working on?' }))
  await waitFor(() =>
    expect(posts.some((post) => post.url === '/api/agents/builder/chats')).toBe(true),
  )
})

test('the screen shortcut shows while Hermes serves the agent (3.12.1)', async () => {
  stub()
  renderDirect()
  const link = await screen.findByRole('link', { name: `Look at ${builder.name}'s screen` })
  expect(link.getAttribute('href')).toBe('/b/screen/builder')
})

test('no screen shortcut for a coding agent or an agent Hermes isn’t serving', async () => {
  stub()
  const view = renderDirect()
  await screen.findByRole('heading', { name: 'builder' })
  view.unmount()
  renderInRoom(
    <DirectChat
      agent={{ ...builder, runtime: 'codex' }}
      agents={agents}
      phone={false}
      infoOpen={false}
      onToggleInfo={() => undefined}
      onChatInfo={() => undefined}
      onBackToChats={() => undefined}
    />,
    ['/b?with=builder'],
  )
  await screen.findByRole('heading', { name: 'builder' })
  expect(screen.queryByRole('link', { name: /screen/ })).toBeNull()
})
