import { fireEvent, screen, waitFor } from '@testing-library/react'
import { useLocation } from 'react-router'
import { afterEach, expect, test, vi } from 'vitest'
import {
  agents,
  disposeRoomTest,
  jsonResponse,
  makeJob,
  mockFetch,
  renderInRoom,
  room,
} from '../room/room-test-utils.tsx'
import { ChatInfo } from './ChatInfo.tsx'

afterEach(() => {
  disposeRoomTest()
  vi.unstubAllGlobals()
})

function Where() {
  const location = useLocation()
  return <span data-testid="where">{`${location.pathname}${location.search}`}</span>
}

// 3.24.0: the All topics screen is gone; Info lists the topics and starts a new one (the same as /new <title>).
test('Info lists the topics and starts a new one like /new, then goes to it and closes the sheet', async () => {
  const posted: unknown[] = []
  vi.stubGlobal(
    'fetch',
    mockFetch((url, init) => {
      if (url === '/api/rooms/room-1/jobs' && init.method === 'POST') {
        posted.push(JSON.parse(String(init.body)))
        return jsonResponse(makeJob({ id: 'job-new', title: 'Fix login', state: 'open' }))
      }
      return jsonResponse({ asOfSeq: 1, items: [] })
    }),
  )
  const onNavigate = vi.fn()
  renderInRoom(
    <>
      <ChatInfo
        room={room}
        agents={agents}
        jobs={[
          makeJob({ id: 'job-default', title: 'Team room', isDefault: true }),
          makeJob({ id: 'job-1', title: 'Activity feed' }),
        ]}
        everyone
        phone
        onNavigate={onNavigate}
      />
      <Where />
    </>,
  )

  expect(screen.getByRole('heading', { name: 'Topics' })).toBeDefined()
  expect(screen.getByRole('link', { name: /Activity feed/ })).toBeDefined()
  expect(screen.queryByRole('link', { name: 'All topics' })).toBeNull()

  const add = screen.getByRole('button', { name: 'New topic' })
  expect(add.hasAttribute('disabled')).toBe(true)
  fireEvent.change(screen.getByLabelText('Topic title'), { target: { value: 'Fix login' } })
  fireEvent.click(add)

  await waitFor(() => expect(posted).toEqual([{ title: 'Fix login' }]))
  await waitFor(() => expect(screen.getByTestId('where').textContent).toContain('job=job-new'))
  expect(onNavigate).toHaveBeenCalled()
})

test('a failed New topic says why and keeps the title', async () => {
  vi.stubGlobal(
    'fetch',
    mockFetch((url, init) =>
      url === '/api/rooms/room-1/jobs' && init.method === 'POST'
        ? jsonResponse({ error: { code: 'invalid', message: 'That title is taken.' } }, 409)
        : jsonResponse({ asOfSeq: 1, items: [] }),
    ),
  )
  renderInRoom(<ChatInfo room={room} agents={agents} jobs={[]} everyone />)
  fireEvent.change(screen.getByLabelText('Topic title'), { target: { value: 'Fix login' } })
  fireEvent.click(screen.getByRole('button', { name: 'New topic' }))
  expect((await screen.findByRole('alert')).textContent).toContain('That title is taken.')
  expect((screen.getByLabelText('Topic title') as HTMLInputElement).value).toBe('Fix login')
})

test('each topic row shows its unread count; closed topics stay listed with a check', () => {
  renderInRoom(
    <ChatInfo
      room={room}
      agents={agents}
      jobs={[
        makeJob({ id: 'job-1', title: 'Activity feed', unread: 3 }),
        makeJob({ id: 'job-2', title: 'Quiet one', unread: 0 }),
        makeJob({ id: 'job-3', title: 'Old news', state: 'closed', unread: 120 }),
      ]}
      everyone
    />,
  )
  const feed = screen.getByRole('link', { name: /Activity feed/ })
  expect(feed.querySelector('.bold-unread')?.textContent).toBe('3')
  expect(screen.getByLabelText('3 unread')).toBeDefined()
  expect(screen.getByRole('link', { name: /Quiet one/ }).querySelector('.bold-unread')).toBeNull()
  const closed = screen.getByRole('link', { name: /Old news/ })
  expect(closed.textContent).toContain('✓')
  expect(closed.querySelector('.bold-unread')?.textContent).toBe('99+')
  expect(document.querySelector('details.bold-chat-closed')).toBeNull()
})

test('more than three closed topics fold under a Closed topics (N) disclosure', () => {
  const closed = [1, 2, 3, 4].map((n) =>
    makeJob({ id: `job-c${n}`, title: `Closed ${n}`, state: 'closed' }),
  )
  renderInRoom(
    <ChatInfo
      room={room}
      agents={agents}
      jobs={[makeJob({ id: 'job-1', title: 'Activity feed' }), ...closed]}
      everyone
    />,
  )
  const disclosure = document.querySelector('details.bold-chat-closed') as HTMLDetailsElement
  expect(disclosure.querySelector('summary')?.textContent).toBe('Closed topics (4)')
  expect(disclosure.open).toBe(false)
  expect(disclosure.querySelectorAll('a').length).toBe(4)
  // The open topic stays outside it.
  expect(disclosure.contains(screen.getByRole('link', { name: /Activity feed/ }))).toBe(false)
})
