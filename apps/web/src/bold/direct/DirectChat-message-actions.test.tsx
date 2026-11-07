import { fireEvent, screen, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { jsonResponse, makeMessage, mockFetch } from '../room/room-test-utils.tsx'
import {
  directRoom,
  newer,
  older,
  renderDirect,
  resetDirectChatTest,
  stub,
  text,
  thread,
} from './DirectChat-test-helpers.tsx'

afterEach(resetDirectChatTest)

test('rewind, retry, pin and delete stay on a reply’s action row', async () => {
  stub()
  renderDirect()
  await screen.findByText('Sockets go both ways.')
  const actions = screen.getAllByRole('group', { name: 'Actions for message from builder' }).at(-1)!
  expect(within(actions).getByRole('button', { name: /^Try another reply/ })).toBeTruthy()
  expect(within(actions).getByRole('button', { name: /^Pin message/ })).toBeTruthy()
  expect(within(actions).getByRole('button', { name: /^Delete message/ })).toBeTruthy()
  expect(within(actions).getByRole('button', { name: /^Copy message/ })).toBeTruthy()
})

test('the agent’s typing is shown in the conversation', async () => {
  const base = stub()
  void base
  vi.stubGlobal(
    'fetch',
    mockFetch((url) => {
      if (url === '/api/agents/builder/direct')
        return jsonResponse({ asOfSeq: 1, room: directRoom, chats: [newer, older] })
      if (url.startsWith('/api/rooms/direct-builder/messages'))
        return jsonResponse({ asOfSeq: 1, items: thread, nextCursor: null, jobId: 'main-chat' })
      if (url === '/api/questions?status=all') return jsonResponse({ asOfSeq: 1, items: [] })
      return jsonResponse({ asOfSeq: 0, items: [] })
    }),
  )
  const { emit } = renderDirect()
  await screen.findByText('Sockets go both ways.')
  emit({
    seq: 2,
    type: 'typing',
    data: { roomId: directRoom.id, agentId: 'builder', text: 'is thinking' },
  } as never)
  await screen.findByText(/is thinking/)
})

test('"Load earlier" fetches the page before the oldest message', async () => {
  stub()
  const base = globalThis.fetch
  const urls: string[] = []
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.startsWith('/api/rooms/direct-builder/messages')) {
      urls.push(url)
      if (url.includes('before=cursor-1'))
        return Promise.resolve(
          jsonResponse({
            asOfSeq: 1,
            items: [
              makeMessage({
                id: 'ancient',
                roomId: directRoom.id,
                jobId: 'chat-old',
                parts: text('The very first question.'),
                createdAt: '2026-10-20T09:00:00.000Z',
              }),
            ],
            nextCursor: null,
            jobId: 'main-chat',
          }),
        )
      return Promise.resolve(
        jsonResponse({
          asOfSeq: 1,
          items: [
            makeMessage({
              id: 'recent',
              roomId: directRoom.id,
              jobId: 'chat-new',
              parts: text('A recent line.'),
              createdAt: '2026-10-24T11:13:00.000Z',
            }),
          ],
          nextCursor: 'cursor-1',
          jobId: 'main-chat',
        }),
      )
    }
    return base(input, init)
  })
  const { container } = renderDirect()
  fireEvent.click(await screen.findByRole('button', { name: 'Load earlier' }))
  await screen.findByText('The very first question.')
  const lines = [...container.querySelectorAll('.bold-message')].map((node) => node.textContent)
  expect(lines[0]).toContain('The very first question.')
  expect(lines[1]).toContain('A recent line.')
  expect(screen.queryByRole('button', { name: 'Load earlier' })).toBeNull()
  expect(urls.some((url) => url.includes('all=1'))).toBe(true)
})
