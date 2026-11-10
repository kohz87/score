import { fireEvent, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  agents,
  disposeRoomTest,
  jsonResponse,
  mockFetch,
  renderInRoom,
  room,
} from '../room/room-test-utils.tsx'
import { MembersInfo } from './MembersInfo.tsx'

/** Decision 178, part 4: Chat info › Members opens by itself when an agent here runs at another effort, and says so folded. */
beforeEach(() => window.localStorage.clear())
afterEach(() => {
  disposeRoomTest()
  vi.unstubAllGlobals()
})

function stubEfforts(items: { roomId: string; agentId: string; effort: string }[]) {
  vi.stubGlobal(
    'fetch',
    mockFetch((url) => {
      if (url === '/api/rooms/room-1/efforts') return jsonResponse({ asOfSeq: 0, items })
      return jsonResponse({ asOfSeq: 0, items: [] })
    }),
  )
}

test('with a member set differently the section starts open and its folded header says how many', async () => {
  stubEfforts([{ roomId: 'room-1', agentId: 'reviewer', effort: 'high' }])
  renderInRoom(<MembersInfo room={room} agents={agents} />, ['/b'])
  const toggle = await screen.findByRole('button', { name: /Members/ })
  expect(toggle.getAttribute('aria-expanded')).toBe('true')
  expect(screen.getByText('high')).toBeTruthy()
  fireEvent.click(toggle)
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  expect(toggle.textContent).toContain(`Members · ${room.members.length} · 1 set differently here`)
})

test('with none set the section folds as it always has, and its header only counts the members', async () => {
  stubEfforts([])
  renderInRoom(<MembersInfo room={room} agents={agents} />, ['/b'])
  const toggle = await screen.findByRole('button', { name: /Members/ })
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  expect(toggle.textContent).toContain(`Members · ${room.members.length}`)
  expect(toggle.textContent).not.toContain('set differently')
})
