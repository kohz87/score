import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { jsonResponse } from '../room/room-test-utils.tsx'
import { renderDirect, resetDirectChatTest, stub } from './DirectChat-test-helpers.tsx'

afterEach(resetDirectChatTest)

/** Decision 182 in a one-to-one: a bare `/model <name>` sets this chat's model, never the agent's own (the classic path). */
test('/model fake-model in a direct chat sets this chat’s model and leaves the agent’s own alone', async () => {
  const puts: string[] = []
  const posts = stub([], (url) => {
    if (url === '/api/rooms/direct-builder/models') return jsonResponse({ asOfSeq: 0, items: [] })
    if (url === '/api/agents/builder/model-settings')
      return jsonResponse({
        effort: null,
        fallbacks: [],
        fallbacksEditable: true,
        aliases: [],
        speech: {
          stt: { provider: null, model: null },
          tts: { provider: null, model: null, voice: null },
        },
      })
    if (url.startsWith('/api/models')) return jsonResponse({ items: [] })
    if (url === '/api/agents/builder/chat-models')
      return jsonResponse({ agentId: 'builder', chats: [] })
    return undefined
  })
  const realFetch = vi.mocked(fetch).getMockImplementation()!
  vi.mocked(fetch).mockImplementation((input, init) => {
    const url = String(input)
    if (init?.method === 'PUT') {
      puts.push(url)
      if (url.endsWith('/api/rooms/direct-builder/models/builder'))
        return Promise.resolve(
          jsonResponse({
            roomId: 'direct-builder',
            agentId: 'builder',
            current: {
              roomId: 'direct-builder',
              agentId: 'builder',
              model: 'fake-model',
              provider: 'local',
              label: 'fake-model',
            },
            replaced: null,
          }),
        )
    }
    return realFetch(input, init)
  })
  renderDirect()
  await screen.findByText('Sockets go both ways.')
  fireEvent.change(screen.getByPlaceholderText('Message builder privately'), {
    target: { value: '/model fake-model' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  await waitFor(() => expect(puts).toEqual(['/api/rooms/direct-builder/models/builder']))
  expect(puts.some((url) => url.endsWith('/api/agents/builder/model'))).toBe(false)
  expect(posts.some((post) => post.url === '/api/rooms/direct-builder/messages')).toBe(false)
})
