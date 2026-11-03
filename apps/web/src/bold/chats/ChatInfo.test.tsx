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
