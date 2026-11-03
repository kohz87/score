import type { Room, SharedWorkspace } from '@score/contract'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import {
  agents,
  disposeRoomTest,
  jsonResponse,
  mockFetch,
  renderInRoom,
  room as teamRoom,
} from './room/room-test-utils.tsx'
import { RoomMenu } from './room/RoomMenus.tsx'
import { BoldWorkspaces } from './BoldWorkspaces.tsx'

afterEach(() => {
  disposeRoomTest()
  vi.unstubAllGlobals()
})

type Call = { method: string; path: string; body: unknown }
let workspaces: SharedWorkspace[] = []
const calls: Call[] = []

function stub(extra?: (path: string, method: string) => Response | null) {
  calls.length = 0
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
      const forced = extra?.(parsed.pathname, method)
      if (forced) return forced
      if (parsed.pathname === '/api/workspaces' && method === 'GET')
        return jsonResponse({ workspaces })
      if (parsed.pathname.endsWith('/workspace') && parsed.pathname.startsWith('/api/agents/'))
        return jsonResponse({ root: '/work/feed', available: true, reason: null })
      return jsonResponse({}, method === 'DELETE' ? 204 : 200)
    }),
  )
}
const feed: SharedWorkspace = {
  id: 'w1',
  name: 'activity-feed',
  path: '/work/feed',
  agentIds: ['lead'],
  roomIds: ['room-b'],
}

test('Settings › Workspaces lists a card per workspace, toggles agents and says how many rooms use it', async () => {
  workspaces = [feed]
  stub()
  renderInRoom(<BoldWorkspaces agents={agents} rooms={[{ id: 'room-b', name: '#beta' }]} />)
  const card = await screen.findByRole('region', { name: 'activity-feed' })
  expect(within(card).getByText('/work/feed')).toBeDefined()
  expect(within(card).getByText('Used by 1 room')).toBeDefined()
  const lead = within(card).getByRole('button', { name: 'lead' })
  expect(lead.getAttribute('aria-pressed')).toBe('true')
  const builder = within(card).getByRole('button', { name: 'builder' })
  expect(builder.getAttribute('aria-pressed')).toBe('false')
  fireEvent.click(builder)
  await waitFor(() =>
    expect(calls.find((call) => call.method === 'PATCH')).toMatchObject({
      path: '/api/workspaces/w1',
      body: { agentIds: ['lead', 'builder'] },
    }),
  )
})

test('an assigned Hermes agent can use the workspace as its folder; one whose folder it is says so', async () => {
  workspaces = [{ ...feed, agentIds: ['lead', 'builder'] }]
  stub((path) =>
    path === '/api/agents/builder/workspace'
      ? jsonResponse({ root: '/elsewhere', available: true, reason: null })
      : null,
  )
  renderInRoom(<BoldWorkspaces agents={agents} rooms={[]} />)
  expect(await screen.findByText('lead’s folder')).toBeDefined()
  fireEvent.click(await screen.findByRole('button', { name: 'Use as builder’s folder' }))
  await waitFor(() =>
    expect(calls.find((call) => call.path === '/api/workspaces/w1/use-as-folder')?.body).toEqual({
      agentId: 'builder',
    }),
  )
})

test('New workspace posts the name, folder and create flag; the server’s refusal is shown', async () => {
  workspaces = []
  stub((path, method) =>
    path === '/api/workspaces' && method === 'POST'
      ? jsonResponse(
          { error: { code: 'workspace_unavailable', message: 'That folder doesn’t exist.' } },
          422,
        )
      : null,
  )
  renderInRoom(<BoldWorkspaces agents={agents} rooms={[]} />)
  fireEvent.click(await screen.findByRole('button', { name: 'New workspace' }))
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'notes' } })
  fireEvent.change(screen.getByLabelText('Folder on this computer'), {
    target: { value: '~/notes' },
  })
  fireEvent.click(screen.getByRole('checkbox', { name: 'Create the folder if it doesn’t exist' }))
  fireEvent.click(screen.getByRole('button', { name: 'Add workspace' }))
  await waitFor(() =>
    expect(calls.find((call) => call.method === 'POST')?.body).toEqual({
      name: 'notes',
      path: '~/notes',
      create: true,
    }),
  )
  expect((await screen.findByRole('alert')).textContent).toBe('That folder doesn’t exist.')
})

test('Delete asks first and says the folder stays on disk', async () => {
  workspaces = [feed]
  stub()
  renderInRoom(<BoldWorkspaces agents={agents} rooms={[]} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))
  expect(screen.getByText(/The folder stays on disk/)).toBeDefined()
  expect(calls.some((call) => call.method === 'DELETE')).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
  await waitFor(() =>
    expect(calls.find((call) => call.method === 'DELETE')?.path).toBe('/api/workspaces/w1'),
  )
})

test('the room menu shows the room’s workspace and sets another', async () => {
  workspaces = [feed, { ...feed, id: 'w2', name: 'notes', path: '/work/notes', roomIds: [] }]
  const current: Room = {
    ...teamRoom,
    id: 'room-b',
    name: '#beta',
    role: 'room',
    workspaceId: 'w1',
  }
  stub((path, method) =>
    path === '/api/rooms/room-b/workspace' && method === 'PUT'
      ? jsonResponse({ ...current, workspaceId: 'w2' })
      : null,
  )
  renderInRoom(<RoomMenu room={current} onShare={() => undefined} onDelete={() => undefined} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Room menu' }))
  const item = await screen.findByRole('menuitem', { name: 'Workspace: activity-feed' })
  fireEvent.click(item)
  fireEvent.click(await screen.findByRole('radio', { name: 'notes' }))
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() =>
    expect(calls.find((call) => call.method === 'PUT')?.body).toEqual({ workspaceId: 'w2' }),
  )
})
