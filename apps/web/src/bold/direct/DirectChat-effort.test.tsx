import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'
import { jsonResponse } from '../room/room-test-utils.tsx'
import { renderDirect, resetDirectChatTest, stub } from './DirectChat-test-helpers.tsx'

afterEach(resetDirectChatTest)

/** Decision 178, part 2 in a one-to-one: `/effort` is typed in the direct composer and acts on that chat's agent. */
function stubEffort() {
  const puts: string[] = []
  const posts = stub([], (url) => {
    if (url === '/api/agents/builder/efforts')
      return jsonResponse({
        agentId: 'builder',
        own: 'medium',
        levels: ['low', 'medium', 'high', 'max'],
        chats: [],
      })
    if (url === '/api/rooms/direct-builder/efforts') return jsonResponse({ asOfSeq: 0, items: [] })
    if (url.endsWith('/efforts/builder')) {
      puts.push(url)
      return jsonResponse({ roomId: 'direct-builder', agentId: 'builder', effort: 'high' })
    }
    return undefined
  })
  return { posts, puts }
}

test('the / palette offers the effort choices for the agent, and /effort high sets it for this chat', async () => {
  const { posts, puts } = stubEffort()
  renderDirect()
  await screen.findByText('Sockets go both ways.')
  const box = screen.getByPlaceholderText('Message builder privately')
  fireEvent.change(box, { target: { value: '/eff' } })
  const list = await screen.findByRole('listbox', { name: 'Commands' })
  expect(within(list).getByText(/Effort for builder in this chat/)).toBeTruthy()
  fireEvent.click(within(list).getByText('/effort high'))
  expect((box as HTMLTextAreaElement).value).toBe('/effort high ')
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  expect(await screen.findByText(/builder works at effort high in this chat/)).toBeDefined()
  await waitFor(() => expect(puts).toHaveLength(1))
  expect(posts.some((post) => post.url === '/api/rooms/direct-builder/messages')).toBe(false)
  expect(screen.queryByText(/I don’t know \/effort/)).toBeNull()
})

test('/effort with a level the agent does not take says which it takes and sends nothing', async () => {
  const { posts, puts } = stubEffort()
  renderDirect()
  await screen.findByText('Sockets go both ways.')
  fireEvent.change(screen.getByPlaceholderText('Message builder privately'), {
    target: { value: '/effort turbo' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  expect(
    await screen.findByText(/builder takes low, medium, high, max\. Nothing was sent\./),
  ).toBeDefined()
  expect(puts).toHaveLength(0)
  expect(posts.some((post) => post.url === '/api/rooms/direct-builder/messages')).toBe(false)
})
