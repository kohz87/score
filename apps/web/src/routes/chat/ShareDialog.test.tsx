import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import type { Room } from '@score/contract'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createQueryClient } from '../../data/query-client.ts'
import { SharesSection } from '../settings/SharesSection.tsx'
import { ShareDialog } from './ShareDialog.tsx'

const room: Room = {
  id: 'r1',
  name: '#launch',
  kind: 'room',
  leadAgentId: null,
  members: [],
  unread: 0,
  activeAgents: [],
  channels: [],
}
const share = {
  id: 'share-1',
  roomId: 'r1',
  roomName: '#launch',
  createdAt: '2026-10-09T10:00:00.000Z',
  expiresAt: '2026-10-16T10:00:00.000Z',
  views: 3,
  includeImages: false,
  status: 'active',
  roomChanged: false,
}
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>
let active: (typeof share)[]
const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status })

beforeEach(() => {
  active = [share]
  fetchMock = vi.fn(async (input, init) => {
    const url = String(input)
    if (init?.method === 'POST' && url === '/api/rooms/r1/shares') {
      const body = JSON.parse(String(init.body)) as { password: string }
      if (body.password === 'wrong password')
        return json({ error: { code: 'wrong_password', message: 'no' } }, 403)
      return json({
        id: 'share-2',
        url: 'https://score.lan/s/TOKEN',
        expiresAt: '2026-10-16T10:00:00.000Z',
      })
    }
    if (init?.method === 'DELETE') {
      active = []
      return new Response(null, { status: 204 })
    }
    return json({ items: active })
  })
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
const wrap = (node: React.ReactNode) =>
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>,
  )
const posted = () =>
  fetchMock.mock.calls
    .filter(([, init]) => init?.method === 'POST')
    .map(([, init]) => JSON.parse(String(init?.body)))

test('says who can read the link, then creates it with the password, expiry and image choice', async () => {
  wrap(<ShareDialog room={room} close={() => {}} />)
  expect(screen.getByText(/can reach this Score/)).toBeDefined()
  expect(screen.getByText(/LAN or\s+Tailscale/)).toBeDefined()
  const create = screen.getByRole('button', { name: 'Create link' })
  expect(create.hasAttribute('disabled')).toBe(true)
  fireEvent.change(screen.getByLabelText('Security password'), {
    target: { value: 'correct horse' },
  })
  fireEvent.change(screen.getByLabelText('Link works for'), { target: { value: '3' } })
  fireEvent.click(screen.getByLabelText(/Include the images/))
  fireEvent.click(create)
  await screen.findByText('https://score.lan/s/TOKEN')
  expect(posted()).toEqual([{ password: 'correct horse', expiresInDays: 3, includeImages: true }])
  // The password field is cleared once the request is done.
  expect((screen.getByLabelText('Security password') as HTMLInputElement).value).toBe('')
})

test('a wrong password is explained and no link is shown', async () => {
  wrap(<ShareDialog room={room} close={() => {}} />)
  fireEvent.change(screen.getByLabelText('Security password'), {
    target: { value: 'wrong password' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Create link' }))
  expect((await screen.findByRole('alert')).textContent).toBe('That is not the security password.')
  expect(screen.queryByRole('group', { name: 'New share link' })).toBeNull()
})

test('active links for the room can be revoked from the dialog', async () => {
  wrap(<ShareDialog room={room} close={() => {}} />)
  const list = await screen.findByRole('list', { name: 'Active share links' })
  expect(list.textContent).toContain('3 views')
  fireEvent.click(screen.getByRole('button', { name: 'Revoke' }))
  await waitFor(() => expect(screen.queryByRole('list', { name: 'Active share links' })).toBeNull())
  expect(
    fetchMock.mock.calls.some(
      ([url, init]) => String(url) === '/api/shares/share-1' && init?.method === 'DELETE',
    ),
  ).toBe(true)
})

test('a job share names the job and sends its id in the request', async () => {
  const job = {
    id: 'job-activity',
    roomId: room.id,
    title: 'Activity feed',
    state: 'working' as const,
    holderAgentId: 'builder',
    isDefault: false,
    exchangeBudget: 8,
    jobTurnLimit: 40,
    spendCapUsd: null,
    recipe: null,
    unread: 0,
    activeAgents: [],
    lastMessageAt: null,
    messageCount: 0,
    summary: null,
    source: null,
    reportBack: null,
    createdAt: '2026-10-24T09:00:00.000Z',
    updatedAt: '2026-10-24T09:00:00.000Z',
  }
  wrap(<ShareDialog room={room} job={job} close={() => {}} />)
  expect(screen.getByRole('heading', { name: 'Share Activity feed' })).toBeDefined()
  expect(screen.getByText(/the job’s/)).toBeDefined()
  fireEvent.change(screen.getByLabelText('Security password'), {
    target: { value: 'correct horse' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Create link' }))
  await screen.findByText('https://score.lan/s/TOKEN')
  expect(posted()).toEqual([
    {
      password: 'correct horse',
      expiresInDays: 7,
      includeImages: false,
      jobId: 'job-activity',
    },
  ])
})

test('Settings › Shares lists every link with room, dates and views, and revokes', async () => {
  wrap(<SharesSection />)
  const list = await screen.findByRole('list', { name: 'Share links' })
  expect(list.textContent).toContain('#launch')
  expect(list.textContent).toContain('3 views')
  fireEvent.click(screen.getByRole('button', { name: /Revoke the link to #launch/ }))
  await waitFor(() => expect(screen.queryByRole('list', { name: 'Share links' })).toBeNull())
})

test('Settings › Shares marks a link whose room changed after the snapshot', async () => {
  active = [{ ...share, roomChanged: true }]
  wrap(<SharesSection />)
  const list = await screen.findByRole('list', { name: 'Share links' })
  expect(list.textContent).toContain('room changed since')
})
