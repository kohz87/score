import type { Room } from '@score/contract'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { RoomTitle } from './RoomMenus.tsx'
import { NewTeamDialog } from './TeamDialogs.tsx'
import {
  agents,
  disposeRoomTest,
  jsonResponse,
  mockFetch,
  renderInRoom,
  room as firstTeam,
} from './room-test-utils.tsx'

afterEach(() => {
  disposeRoomTest()
  vi.unstubAllGlobals()
})

// 3.4.0 (decision 136): teams the person makes next to the first team room.
const everyone: Room = { ...firstTeam, everyone: true }
const chosen: Room = {
  ...firstTeam,
  id: 'team-2',
  name: 'Review crew',
  everyone: false,
  members: ['builder', 'reviewer'],
  leadAgentId: 'reviewer',
}

function stub(teams: Room[], calls: { method: string; path: string; body: unknown }[] = []) {
  vi.stubGlobal(
    'fetch',
    mockFetch((url, init) => {
      const parsed = new URL(url, 'http://x')
      const method = init.method ?? 'GET'
      calls.push({
        method,
        path: parsed.pathname,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      })
      if (parsed.pathname === '/api/agents') return jsonResponse({ asOfSeq: 1, items: agents })
      if (parsed.pathname === '/api/rooms')
        return jsonResponse({ asOfSeq: 1, rooms: [], directs: [], projects: [] })
      if (parsed.pathname === '/api/team-rooms' && method === 'GET')
        return jsonResponse({ asOfSeq: 1, items: teams })
      if (parsed.pathname === '/api/team-rooms' && method === 'POST')
        return jsonResponse(chosen, 201)
      if (parsed.pathname === '/api/outside-sessions')
        return jsonResponse({ items: [], unavailable: [] })
      return jsonResponse({})
    }),
  )
  return calls
}

function title(current: Room, onSelectRoom: (room: Room) => void = () => undefined) {
  return renderInRoom(
    <RoomTitle
      current={current}
      teamRoom={everyone}
      teamJobCount={0}
      rooms={[]}
      agents={agents}
      onSelectRoom={onSelectRoom}
      onOpenElsewhere={() => undefined}
      onShare={() => undefined}
      onDelete={() => undefined}
    />,
  )
}

test('the switcher lists the first team room, then the teams, then New team…', async () => {
  stub([everyone, chosen])
  title(everyone)
  fireEvent.click(await screen.findByRole('button', { name: /Team room/ }))
  const list = await screen.findByRole('listbox')
  await waitFor(() => expect(within(list).getByText('Review crew')).toBeDefined())
  const names = within(list)
    .getAllByRole('option')
    .map((option) => option.querySelector('b')?.textContent)
  expect(names.slice(0, 3)).toEqual(['Team room', 'Review crew', 'New team…'])
  expect(within(list).getAllByText('Review crew')).toHaveLength(1)
})

test('choosing a team selects that room', async () => {
  stub([everyone, chosen])
  const onSelectRoom = vi.fn()
  title(everyone, onSelectRoom)
  fireEvent.click(await screen.findByRole('button', { name: /Team room/ }))
  fireEvent.click(await screen.findByRole('option', { name: /Review crew/ }))
  expect(onSelectRoom).toHaveBeenCalledWith(expect.objectContaining({ id: 'team-2' }))
})

test('New team… makes a team from the checked agents and a lead among them, then opens it', async () => {
  const calls = stub([everyone])
  const onSelectRoom = vi.fn()
  title(everyone, onSelectRoom)
  fireEvent.click(await screen.findByRole('button', { name: /Team room/ }))
  fireEvent.click(await screen.findByRole('option', { name: /New team…/ }))
  const dialog = await screen.findByRole('dialog', { name: 'New team' })
  expect(dialog.getAttribute('data-protected')).toBe('any')
  const create = within(dialog).getByRole('button', { name: 'Create team' })
  expect(create.hasAttribute('disabled')).toBe(true)
  fireEvent.change(within(dialog).getByRole('textbox', { name: 'Name' }), {
    target: { value: 'Review crew' },
  })
  await waitFor(() =>
    expect(within(dialog).getByRole('checkbox', { name: 'builder' })).toBeDefined(),
  )
  fireEvent.click(within(dialog).getByRole('checkbox', { name: 'builder' }))
  fireEvent.click(within(dialog).getByRole('checkbox', { name: 'reviewer' }))
  // The lead is one of the checked members only.
  const lead = within(dialog).getByRole('combobox', { name: 'Lead' })
  expect(within(lead).queryByRole('option', { name: 'lead' })).toBeNull()
  fireEvent.change(lead, { target: { value: 'reviewer' } })
  expect(create.hasAttribute('disabled')).toBe(false)
  fireEvent.click(create)
  await waitFor(() =>
    expect(onSelectRoom).toHaveBeenCalledWith(expect.objectContaining({ id: 'team-2' })),
  )
  expect(calls.find((call) => call.method === 'POST')?.body).toEqual({
    name: 'Review crew',
    members: ['builder', 'reviewer'],
    leadAgentId: 'reviewer',
  })
})

test('New team shows the server’s refusal inline and stays open', async () => {
  vi.stubGlobal(
    'fetch',
    mockFetch((url, init) => {
      const path = new URL(url, 'http://x').pathname
      if (path === '/api/agents') return jsonResponse({ asOfSeq: 1, items: agents })
      if (path === '/api/team-rooms' && init.method === 'POST')
        return jsonResponse({ error: { code: 'conflict', message: 'taken' } }, 409)
      return jsonResponse({})
    }),
  )
  const onCreated = vi.fn()
  renderInRoom(<NewTeamDialog onClose={() => undefined} onCreated={onCreated} />)
  const dialog = await screen.findByRole('dialog', { name: 'New team' })
  fireEvent.change(within(dialog).getByRole('textbox', { name: 'Name' }), {
    target: { value: 'Review crew' },
  })
  await waitFor(() => expect(within(dialog).getByRole('checkbox', { name: 'lead' })).toBeDefined())
  fireEvent.click(within(dialog).getByRole('checkbox', { name: 'lead' }))
  fireEvent.change(within(dialog).getByRole('combobox', { name: 'Lead' }), {
    target: { value: 'lead' },
  })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Create team' }))
  expect((await within(dialog).findByRole('alert')).textContent).toContain('already has that name')
  expect(onCreated).not.toHaveBeenCalled()
})

test('a team’s menu renames, archives and deletes, and edits members; the first team room only the lead', async () => {
  stub([everyone, chosen])
  title(chosen)
  fireEvent.click(await screen.findByRole('button', { name: 'Room menu' }))
  const menu = await screen.findByRole('menu')
  for (const name of ['Rename…', 'Archive', 'Team lead…', 'Members…', 'Delete Review crew'])
    expect(within(menu).getByRole('menuitem', { name })).toBeDefined()
  for (const name of ['Pin', 'Project…'])
    expect(within(menu).queryByRole('menuitem', { name })).toBeNull()
  disposeRoomTest()

  stub([everyone, chosen])
  title(everyone)
  fireEvent.click(await screen.findByRole('button', { name: 'Room menu' }))
  const first = await screen.findByRole('menu')
  expect(within(first).getByRole('menuitem', { name: 'Team lead…' })).toBeDefined()
  for (const name of ['Rename…', 'Archive', 'Members…'])
    expect(within(first).queryByRole('menuitem', { name })).toBeNull()
})

test('Members… saves the checked agents and keeps the lead checked', async () => {
  const calls = stub([everyone, chosen])
  title(chosen)
  fireEvent.click(await screen.findByRole('button', { name: 'Room menu' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Members…' }))
  const dialog = await screen.findByRole('dialog', { name: 'Members of Review crew' })
  await waitFor(() => expect(within(dialog).getByRole('checkbox', { name: 'lead' })).toBeDefined())
  expect(within(dialog).getByRole('checkbox', { name: 'reviewer' }).hasAttribute('disabled')).toBe(
    true,
  )
  fireEvent.click(within(dialog).getByRole('checkbox', { name: 'builder' }))
  fireEvent.click(within(dialog).getByRole('checkbox', { name: 'lead' }))
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save members' }))
  await waitFor(() => expect(calls.some((call) => call.method === 'PATCH')).toBe(true))
  expect(calls.find((call) => call.method === 'PATCH')?.body).toEqual({
    members: ['reviewer', 'lead'],
  })
})
