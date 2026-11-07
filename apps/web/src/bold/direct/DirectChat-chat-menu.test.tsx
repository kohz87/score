import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { jsonResponse } from '../room/room-test-utils.tsx'
import {
  mainChat,
  newer,
  older,
  renderDirect,
  resetDirectChatTest,
  stub,
} from './DirectChat-test-helpers.tsx'

afterEach(resetDirectChatTest)

async function openChatMenu(search: string, chats = [newer, older]) {
  stub(chats)
  renderDirect(search)
  await screen.findByText('Sockets go both ways.')
  fireEvent.click(await screen.findByRole('button', { name: 'Chat menu' }))
}

test('Delete chat is offered for the current chat, and the room’s own thread offers Clear chat instead', async () => {
  await openChatMenu('?with=builder&chat=chat-new')
  expect(screen.getByRole('menuitem', { name: 'Delete chat' })).toBeDefined()
  expect(screen.queryByRole('menuitem', { name: 'Clear chat' })).toBeNull()
})

test('the main chat (the default thread) is never deleted: it offers Clear chat instead', async () => {
  await openChatMenu('?with=builder&chat=main-chat', [newer, mainChat])
  expect(screen.queryByRole('menuitem', { name: 'Delete chat' })).toBeNull()
  expect(screen.getByRole('menuitem', { name: 'Clear chat' })).toBeDefined()
})

test('the chat menu holds Show deleted messages (it no longer sits above the conversation)', async () => {
  await openChatMenu('?with=builder&chat=chat-new')
  expect(screen.getByRole('menuitemcheckbox', { name: 'Show deleted messages' })).toBeDefined()
})

test('Delete chat confirms, deletes the job and says it can be undone', async () => {
  const base = vi.fn()
  await openChatMenu('?with=builder&chat=chat-new')
  const original = globalThis.fetch
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === '/api/jobs/chat-new' && init?.method === 'DELETE') {
      base(String(input))
      return Promise.resolve(jsonResponse({}, 204))
    }
    return original(input, init)
  })
  fireEvent.click(screen.getByRole('menuitem', { name: 'Delete chat' }))
  const dialog = await screen.findByRole('dialog', { name: 'Delete this chat with builder?' })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete chat' }))
  await waitFor(() => expect(base).toHaveBeenCalledWith('/api/jobs/chat-new'))
})

test('Clear chat confirms, posts to the room, and reports how many messages went', async () => {
  await openChatMenu('?with=builder&chat=main-chat', [newer, mainChat])
  const base = globalThis.fetch
  const calls: string[] = []
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === '/api/rooms/direct-builder/clear') {
      calls.push(`${init?.method} ${String(input)}`)
      return Promise.resolve(jsonResponse({ cleared: 3 }))
    }
    return base(input, init)
  })
  fireEvent.click(screen.getByRole('menuitem', { name: 'Clear chat' }))
  const dialog = await screen.findByRole('dialog', { name: 'Clear this chat with builder?' })
  expect(dialog.getAttribute('data-protected')).toBe('any')
  expect(dialog.textContent).toContain(
    'Removes every message of this chat from Score. builder may still remember them. Other chats with builder stay.',
  )
  fireEvent.click(within(dialog).getByRole('button', { name: 'Clear chat' }))
  expect((await within(dialog).findByRole('status')).textContent).toBe('Cleared 3 messages.')
  expect(calls).toEqual(['POST /api/rooms/direct-builder/clear'])
})

test('Clear chat shows the server’s 409 message verbatim', async () => {
  await openChatMenu('?with=builder&chat=main-chat', [newer, mainChat])
  const base = globalThis.fetch
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
    String(input) === '/api/rooms/direct-builder/clear'
      ? Promise.resolve(
          jsonResponse(
            { error: { code: 'conflict', message: 'A message is still being written.' } },
            409,
          ),
        )
      : base(input, init),
  )
  fireEvent.click(screen.getByRole('menuitem', { name: 'Clear chat' }))
  const dialog = await screen.findByRole('dialog', { name: 'Clear this chat with builder?' })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Clear chat' }))
  expect((await within(dialog).findByRole('alert')).textContent).toBe(
    'A message is still being written.',
  )
})
