import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { TeamLeadDialog } from './RoomMenus.tsx'
import {
  agents,
  disposeRoomTest,
  jsonResponse,
  mockFetch,
  renderInRoom,
  room,
} from './room-test-utils.tsx'

afterEach(() => {
  disposeRoomTest()
  vi.unstubAllGlobals()
})

// 3.1.0: choosing the team room's lead.
test('Team lead offers ready Hermes agents, saves the choice and closes', async () => {
  const removed = {
    ...agents[1]!,
    id: 'gone',
    name: 'gone',
    lifecycle: {
      state: 'removed' as const,
      incarnationId: '6f9619ff-8b86-4d11-b42d-00c04fc964ff',
      operationId: null,
    },
  }
  const patches: unknown[] = []
  vi.stubGlobal(
    'fetch',
    mockFetch((url, init) => {
      const path = new URL(url, 'http://x').pathname
      if (path === '/api/agents') return jsonResponse({ asOfSeq: 1, items: [...agents, removed] })
      if (path === `/api/rooms/${room.id}` && init.method === 'PATCH') {
        const body = JSON.parse(String(init.body)) as { leadAgentId: string }
        patches.push(body)
        return jsonResponse({ ...room, leadAgentId: body.leadAgentId })
      }
      return new Response(null, { status: 404 })
    }),
  )
  const onClose = vi.fn()
  renderInRoom(<TeamLeadDialog room={room} onClose={onClose} />)
  const dialog = await screen.findByRole('dialog', { name: 'Team lead' })
  const make = screen.getByRole('button', { name: 'Make lead' })
  // The current lead is chosen; nothing to save yet.
  expect(make.hasAttribute('disabled')).toBe(true)
  await waitFor(() => expect(dialog.textContent).toContain(agents[1]!.name))
  expect(dialog.textContent).not.toContain('gone')
  fireEvent.click(screen.getByRole('radio', { name: agents[1]!.name }))
  fireEvent.click(make)
  await waitFor(() => expect(onClose).toHaveBeenCalled())
  expect(patches).toEqual([{ leadAgentId: agents[1]!.id }])
  expect(dialog.getAttribute('data-protected')).toBe('any')
})
