import type { Room, RoomProject } from '@score/contract'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import {
  agents,
  disposeRoomTest,
  jsonResponse,
  mockFetch,
  renderInRoom,
  room as teamRoom,
} from './room-test-utils.tsx'
import { RoomTitle } from './RoomMenus.tsx'

afterEach(() => {
  disposeRoomTest()
  vi.unstubAllGlobals()
})

const older = (id: string, name: string, extra: Partial<Room> = {}): Room => ({
  ...teamRoom,
  id,
  name,
  role: 'room',
  routing: 'mentions',
  leadAgentId: null,
  ...extra,
})
const project: RoomProject = { id: 'proj-1', name: 'Launch', color: '#6B4EFF' }

function setup(rooms: Room[], projects: RoomProject[], current: Room | null) {
  const calls: { method: string; path: string; body: unknown }[] = []
  const fetchMock = mockFetch((url, init) => {
    const parsed = new URL(url, 'http://x')
    calls.push({
      method: init.method ?? 'GET',
      path: parsed.pathname,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    })
    if (parsed.pathname === '/api/rooms' && (init.method ?? 'GET') === 'GET')
      return jsonResponse({ asOfSeq: 1, rooms, directs: [], projects })
    if (parsed.pathname === '/api/outside-sessions')
      return jsonResponse({ items: [], unavailable: [] })
    if (parsed.pathname === '/api/room-projects')
      return jsonResponse({ id: 'proj-2', name: 'Docs', color: '#19C39A' })
    if (parsed.pathname === '/api/rooms/room-b' && init.method === 'PATCH') {
      const body = JSON.parse(String(init.body)) as { name?: string }
      if (body.name === 'taken') return jsonResponse({ error: { code: 'conflict' } }, 409)
      return jsonResponse({ ...current })
    }
    return jsonResponse({})
  })
  vi.stubGlobal('fetch', fetchMock)
  const view = renderInRoom(
    <RoomTitle
      current={current}
      teamRoom={teamRoom}
      teamJobCount={0}
      rooms={rooms}
      agents={agents}
      onSelectRoom={() => undefined}
      onOpenElsewhere={() => undefined}
      onShare={() => undefined}
      onDelete={() => undefined}
    />,
  )
  return { calls, view }
}

test('the switcher lists pinned first, groups by project and keeps archived rooms behind a toggle', async () => {
  const rooms = [
    older('room-a', '#alpha'),
    older('room-b', '#beta', { pinned: true }),
    older('room-c', '#gamma', { projectId: 'proj-1' }),
    older('room-d', '#delta', { archived: true }),
  ]
  setup(rooms, [project], rooms[0]!)
  fireEvent.click(await screen.findByRole('button', { name: /alpha/ }))
  const list = await screen.findByRole('listbox')
  await waitFor(() => expect(within(list).getByText('Launch')).toBeDefined())
  const names = within(list)
    .getAllByRole('option')
    .map((option) => option.querySelector('b')?.textContent)
  expect(names.slice(0, 4)).toEqual(['Team room', '#beta', '#gamma', '#alpha'])
  expect(within(list).getByText('Pinned')).toBeDefined()
  expect(within(list).queryByText('#delta')).toBeNull()
  fireEvent.click(within(list).getByRole('option', { name: /Show archived/ }))
  expect(within(list).getByText('#delta')).toBeDefined()
  expect(within(list).getByText(/Archived/, { selector: 'span.small' })).toBeDefined()
})

test('the room menu pins, archives and exports as JSON; the team room has none of the organising rows', async () => {
  const b = older('room-b', '#beta')
  const { calls } = setup([b], [], b)
  fireEvent.click(await screen.findByRole('button', { name: 'Room menu' }))
  const menu = await screen.findByRole('menu')
  expect(within(menu).getByRole('menuitem', { name: 'Export as JSON' }).getAttribute('href')).toBe(
    '/api/rooms/room-b/export.json',
  )
  fireEvent.click(within(menu).getByRole('menuitem', { name: 'Pin' }))
  await waitFor(() =>
    expect(calls.find((call) => call.method === 'PATCH')?.body).toEqual({ pinned: true }),
  )
  fireEvent.click(await screen.findByRole('button', { name: 'Room menu' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Archive' }))
  await waitFor(() =>
    expect(calls.filter((call) => call.method === 'PATCH')[1]?.body).toEqual({ archived: true }),
  )
})

test('the team room menu has no rename, pin, archive or project rows', async () => {
  setup([], [], teamRoom)
  fireEvent.click(await screen.findByRole('button', { name: 'Room menu' }))
  const menu = await screen.findByRole('menu')
  for (const name of ['Rename…', 'Pin', 'Archive', 'Project…'])
    expect(within(menu).queryByRole('menuitem', { name })).toBeNull()
  expect(within(menu).getByRole('menuitem', { name: 'Export as JSON' })).toBeDefined()
})

test('Rename checks the name rules and says when another room has the name', async () => {
  const b = older('room-b', '#beta')
  const { calls } = setup([b], [], b)
  fireEvent.click(await screen.findByRole('button', { name: 'Room menu' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename…' }))
  const dialog = await screen.findByRole('dialog')
  expect(dialog.getAttribute('data-protected')).toBe('any')
  const input = within(dialog).getByRole('textbox')
  fireEvent.change(input, { target: { value: 'Not A Slug' } })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Rename' }))
  expect((await within(dialog).findByRole('alert')).textContent).toContain('lowercase')
  expect(calls.some((call) => call.method === 'PATCH')).toBe(false)
  fireEvent.change(input, { target: { value: 'taken' } })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Rename' }))
  expect((await within(dialog).findByRole('alert')).textContent).toContain('already has that name')
  fireEvent.change(input, { target: { value: 'gamma #q4' } })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Rename' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(calls.filter((call) => call.method === 'PATCH').at(-1)?.body).toEqual({
    name: 'gamma #q4',
  })
})

test('Project chooses an existing project, creates one, or clears it', async () => {
  const b = older('room-b', '#beta', { projectId: 'proj-1' })
  const { calls } = setup([b], [project], b)
  fireEvent.click(await screen.findByRole('button', { name: 'Room menu' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Project…' }))
  const dialog = await screen.findByRole('dialog')
  await within(dialog).findByRole('radio', { name: 'Launch' })
  expect((within(dialog).getByRole('radio', { name: 'Launch' }) as HTMLInputElement).checked).toBe(
    true,
  )
  fireEvent.click(within(dialog).getByRole('radio', { name: 'No project' }))
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(calls.filter((call) => call.method === 'PATCH').at(-1)?.body).toEqual({ projectId: null })

  fireEvent.click(await screen.findByRole('button', { name: 'Room menu' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Project…' }))
  const again = await screen.findByRole('dialog')
  fireEvent.change(within(again).getByPlaceholderText('Project name'), {
    target: { value: 'Docs' },
  })
  fireEvent.click(within(again).getByRole('radio', { name: 'Jade' }))
  fireEvent.click(within(again).getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(calls.find((call) => call.path === '/api/room-projects')?.body).toEqual({
    name: 'Docs',
    color: '#19C39A',
  })
  expect(calls.filter((call) => call.method === 'PATCH').at(-1)?.body).toEqual({
    projectId: 'proj-2',
  })
})

test('an archived room that is open stays in the switcher and offers Unarchive in the header', async () => {
  const b = older('room-b', '#beta', { archived: true })
  const { calls } = setup([b, older('room-a', '#alpha')], [], b)
  expect(await screen.findByText('Archived')).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: /beta/ }))
  const list = await screen.findByRole('listbox')
  expect(within(list).getByRole('option', { name: /#beta/ })).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: 'Unarchive' }))
  await waitFor(() =>
    expect(calls.find((call) => call.method === 'PATCH')?.body).toEqual({ archived: false }),
  )
})

test('arrow keys reach the JSON export link and Enter activates it', async () => {
  const b = older('room-b', '#beta')
  setup([b], [], b)
  fireEvent.click(await screen.findByRole('button', { name: 'Room menu' }))
  const menu = await screen.findByRole('menu')
  const json = within(menu).getByRole('menuitem', { name: 'Export as JSON' })
  const items = within(menu).getAllByRole('menuitem')
  items[0]!.focus()
  for (let step = 0; step < items.indexOf(json); step += 1)
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
  expect(document.activeElement).toBe(json)
  const click = vi.fn((event: Event) => event.preventDefault())
  json.addEventListener('click', click)
  json.click()
  expect(click).toHaveBeenCalled()
})
