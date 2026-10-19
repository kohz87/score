import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import type { Room, RoomProject } from '@score/contract'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { RoomList } from './RoomList.tsx'

const room = (id: string, patch: Partial<Room> = {}): Room => ({
  id,
  name: `#${id}`,
  kind: 'room',
  leadAgentId: null,
  members: [],
  unread: 0,
  activeAgents: [],
  channels: [],
  ...patch,
})
const project: RoomProject = { id: 'p1', name: 'Launch', color: '#6B4EFF' }
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
function view(rooms: Room[], projects: RoomProject[] = [project]) {
  render(
    <MemoryRouter>
      <RoomList rooms={rooms} projects={projects} selected={undefined} agents={[]} />
    </MemoryRouter>,
  )
}
const patched = () =>
  fetchMock.mock.calls
    .filter(([, init]) => init?.method === 'PATCH')
    .map(([url, init]) => [String(url), JSON.parse(String(init?.body))])

test('lists pinned rooms first, a collapsible project and a Show archived toggle', () => {
  view([
    room('alpha', { pinned: true }),
    room('beta', { projectId: 'p1', tags: ['q4'] }),
    room('old', { archived: true }),
    room('plain'),
  ])
  expect(screen.getByRole('region', { name: 'Pinned rooms' })).toBeDefined()
  const group = screen.getByRole('region', { name: 'Project Launch' })
  expect(within(group).getByRole('link', { name: /#beta/ })).toBeDefined()
  expect(screen.queryByRole('link', { name: /#old/ })).toBeNull()
  const toggle = within(group).getByRole('button', { name: /Launch/, expanded: true })
  fireEvent.click(toggle)
  expect(within(group).queryByRole('link', { name: /#beta/ })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Show archived (1)' }))
  expect(screen.getByRole('link', { name: /#old/ })).toBeDefined()
})

test('a room shows the members that are busy in it now, and none once they are done', () => {
  const busy = room('a', { activeAgents: ['builder'] })
  view([busy, room('b')])
  const link = screen.getByRole('link', { name: /#a/ })
  expect(link.querySelector('.chat-active-agents')?.textContent).toContain('builder')
  expect(
    screen.getByRole('link', { name: /#b/ }).querySelector('.chat-active-agents')?.textContent,
  ).toBe('')
  cleanup()
  view([{ ...busy, activeAgents: [] }])
  expect(
    screen.getByRole('link', { name: /#a/ }).querySelector('.chat-active-agents')?.textContent,
  ).toBe('')
})

test('a tag chip filters the list and toggles off again', () => {
  view([room('a', { tags: ['q4'] }), room('b')])
  fireEvent.click(within(screen.getByRole('list', { name: 'Filter by tag' })).getByText('#q4'))
  expect(screen.queryByRole('link', { name: /#b/ })).toBeNull()
  expect(screen.getByRole('link', { name: /#a/ })).toBeDefined()
  fireEvent.click(within(screen.getByRole('list', { name: 'Filter by tag' })).getByText('#q4'))
  expect(screen.getByRole('link', { name: /#b/ })).toBeDefined()
})

test('the room menu pins, moves to a project and edits tags; Escape returns focus', async () => {
  view([room('a')])
  const button = screen.getByRole('button', { name: 'Actions for #a' })
  fireEvent.click(button)
  expect(button.getAttribute('aria-expanded')).toBe('true')
  fireEvent.click(screen.getByRole('menuitem', { name: 'Pin to top' }))
  await waitFor(() => expect(patched()).toEqual([['/api/rooms/a', { pinned: true }]]))

  fireEvent.click(button)
  fireEvent.click(screen.getByRole('menuitem', { name: 'Move to project…' }))
  fireEvent.change(screen.getByRole('combobox', { name: 'Project' }), { target: { value: 'p1' } })
  await waitFor(() => expect(patched().at(-1)).toEqual(['/api/rooms/a', { projectId: 'p1' }]))

  fireEvent.click(button)
  fireEvent.click(screen.getByRole('menuitem', { name: 'Edit tags…' }))
  fireEvent.change(screen.getByLabelText(/Tags/), { target: { value: '#Q4, urgent q4' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() =>
    expect(patched().at(-1)).toEqual(['/api/rooms/a', { tags: ['q4', 'urgent'] }]),
  )

  fireEvent.click(button)
  const menu = screen.getByRole('menu')
  fireEvent.keyDown(menu, { key: 'Escape' })
  expect(screen.queryByRole('menu')).toBeNull()
  expect(document.activeElement).toBe(button)
})

test('the menu offers Markdown and JSON downloads', () => {
  view([room('a')])
  fireEvent.click(screen.getByRole('button', { name: 'Actions for #a' }))
  expect(screen.getByRole('menuitem', { name: 'Export as Markdown' }).getAttribute('href')).toBe(
    '/api/rooms/a/export.md',
  )
  expect(screen.getByRole('menuitem', { name: 'Export as JSON' }).getAttribute('href')).toBe(
    '/api/rooms/a/export.json',
  )
})

test('creating a project posts its name and colour', async () => {
  view([room('a')], [])
  fireEvent.click(screen.getByRole('button', { name: '＋ Project' }))
  fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'Ship' } })
  fireEvent.click(screen.getByRole('radio', { name: 'Jade' }))
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() => {
    const call = fetchMock.mock.calls.find(([url]) => String(url) === '/api/room-projects')
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ name: 'Ship', color: '#19C39A' })
  })
})
