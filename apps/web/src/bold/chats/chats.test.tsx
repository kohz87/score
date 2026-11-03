import type { AgentSummary } from '@score/contract'
import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { App, appRoutes } from '../../App.tsx'
import { createQueryClient, StreamContext } from '../../data/query-client.ts'
import { createStreamQueryRegistry, immediateFrameScheduler } from '../../data/resync.ts'
import { createStreamClient } from '../../data/stream.ts'

vi.mock('../../notifications/NotificationBridge.tsx', () => ({ NotificationBridge: () => null }))
vi.mock('../../pwa/UpdateBanner.tsx', () => ({ UpdateBanner: () => null }))

const agent = (id: string, status: AgentSummary['status'], color: string): AgentSummary => ({
  id,
  name: id,
  role: '',
  style: { color, shape: 'triangle' },
  status,
  activity: null,
  model: { id: 'm', label: 'Demo' },
  served: true,
})
const agents = [
  agent('lead', 'idle', '#6B4EFF'),
  agent('builder', 'working', '#19C39A'),
  agent('reviewer', 'waiting', '#FFB61E'),
]

const room = (id: string, name: string, extra: object = {}) => ({
  id,
  name,
  kind: 'room',
  leadAgentId: 'lead',
  members: ['lead', 'builder'],
  unread: 0,
  activeAgents: [],
  channels: [],
  routing: 'exchanges',
  ...extra,
})
const teamRoom = room('team-room', 'Team room', {
  role: 'team',
  everyone: true,
  members: ['lead', 'builder', 'reviewer'],
})
const feedBase = room('feed', 'Feed crew', { workspaceId: 'ws1', unread: 2 })
let feedArchived = false
// A getter-like view so one test can archive the room.
const feedRoomNow = () => ({ ...feedBase, archived: feedArchived })
const directBuilder = room('d-builder', 'builder', {
  kind: 'direct',
  role: 'direct',
  leadAgentId: null,
  members: ['builder'],
})
const job = (id: string, roomId: string, title: string, state: string, updatedAt: string) => ({
  id,
  roomId,
  title,
  state,
  isDefault: false,
  holderAgentId: 'lead',
  exchangeBudget: 8,
  jobTurnLimit: 40,
  unread: 0,
  activeAgents: [],
  lastMessageAt: null,
  messageCount: 0,
  summary: null,
  source: null,
  reportBack: null,
  spendCapUsd: null,
  recipe: null,
  createdAt: '2026-11-01T09:00:00.000Z',
  updatedAt,
})
const jobs: Record<string, ReturnType<typeof job>[]> = {
  'team-room': [job('j-old', 'team-room', 'Morning plan', 'done', '2026-11-01T09:00:00.000Z')],
  feed: [
    job('j-feed', 'feed', 'Swap polling for a socket', 'working', '2026-11-03T09:00:00.000Z'),
    job('j-page', 'feed', 'Feed pagination', 'done', '2026-11-02T09:00:00.000Z'),
  ],
}

let phone = false
const disposers: (() => void)[] = []

beforeEach(() => {
  phone = false
  feedArchived = false
  window.localStorage.clear()
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: query === '(max-width: 860px)' ? phone : false,
        media: query,
        addEventListener() {},
        removeEventListener() {},
      }) as unknown as MediaQueryList,
  )
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://x')
      const path = url.pathname
      if (path === '/api/agents')
        return Promise.resolve(Response.json({ asOfSeq: 1, items: agents }))
      if (path === '/api/rooms')
        return Promise.resolve(
          Response.json({
            asOfSeq: 1,
            rooms: [feedRoomNow()],
            directs: [directBuilder],
            projects: [],
          }),
        )
      if (path === '/api/team-rooms')
        return Promise.resolve(Response.json({ asOfSeq: 1, items: [teamRoom] }))
      if (path === '/api/team-room')
        return Promise.resolve(
          Response.json({ asOfSeq: 1, room: teamRoom, jobs: jobs['team-room'] }),
        )
      if (path === '/api/agents/builder/direct')
        return Promise.resolve(
          Response.json({
            asOfSeq: 1,
            room: { ...directBuilder, leadAgentId: 'builder' },
            chats: [
              {
                ...job(
                  'c-builder',
                  'd-builder',
                  'Sockets or polling',
                  'working',
                  '2026-10-24T11:12:00.000Z',
                ),
                lastMessageAt: '2026-10-24T11:14:00.000Z',
                messageCount: 2,
              },
            ],
          }),
        )
      if (path === '/api/workspaces')
        return Promise.resolve(
          Response.json({
            workspaces: [
              {
                id: 'ws1',
                name: 'activity-feed',
                path: '/code/feed',
                agentIds: [],
                roomIds: ['feed'],
              },
            ],
          }),
        )
      const jobsOf = /^\/api\/rooms\/([^/]+)\/jobs$/.exec(path)
      if (jobsOf)
        return Promise.resolve(
          Response.json({ asOfSeq: 1, items: jobs[jobsOf[1]!] ?? [], nextCursor: null }),
        )
      const feed = /^\/api\/rooms\/([^/]+)$/.exec(path)
      if (feed && feed[1] === 'feed')
        return Promise.resolve(Response.json({ asOfSeq: 1, room: feedRoomNow() }))
      if (path.endsWith('/messages'))
        return Promise.resolve(
          Response.json({ asOfSeq: 1, items: [], nextCursor: null, jobId: null }),
        )
      return Promise.resolve(
        Response.json({ asOfSeq: 0, items: [], rooms: [], directs: [], projects: [] }),
      )
    }),
  )
})

afterEach(() => {
  cleanup()
  disposers.splice(0).forEach((dispose) => dispose())
  vi.unstubAllGlobals()
})

class Source extends EventTarget {
  close() {}
}

function open(path: string) {
  const queryClient = createQueryClient()
  const client = createStreamClient({ EventSourceImpl: Source as never })
  const queries = createStreamQueryRegistry(queryClient, client, immediateFrameScheduler)
  const router = createMemoryRouter(appRoutes, { initialEntries: [path] })
  disposers.push(() => {
    router.dispose()
    queries.dispose()
    client.close()
    queryClient.clear()
  })
  render(
    <QueryClientProvider client={queryClient}>
      <StreamContext value={{ client, queries }}>
        <App router={router} />
      </StreamContext>
    </QueryClientProvider>,
  )
  return router
}

const list = () => screen.findByRole('complementary', { name: 'Chats' })

test('the top bar calls the room destination Chats', () => {
  open('/b')
  const nav = screen.getByRole('navigation', { name: 'Main' })
  expect(within(nav).getByRole('button', { name: 'Chats' }).getAttribute('aria-current')).toBe(
    'page',
  )
  expect(within(nav).queryByRole('button', { name: 'Room' })).toBeNull()
})

test('the list has Groups and Direct, newest activity first, with a protected needs-you badge', async () => {
  open('/b')
  const chats = await list()
  await within(chats).findByRole('link', { name: /Feed crew/ })
  const groups = within(within(chats).getByRole('heading', { name: 'Groups' }).parentElement!)
  expect(groups.getAllByRole('link').map((link) => link.textContent)).toEqual([
    expect.stringContaining('Feed crew'),
    expect.stringContaining('Team room'),
  ])
  const feed = groups.getByRole('link', { name: /Feed crew/ })
  expect(feed.textContent).toContain('Swap polling for a socket · working')
  expect(within(feed).getByLabelText('2 unread')).toBeDefined()
  const direct = within(within(chats).getByRole('heading', { name: 'Direct' }).parentElement!)
  const reviewer = direct.getByRole('link', { name: /reviewer/ })
  const badge = reviewer.querySelector('.bold-chat-needs')!
  expect(badge.getAttribute('data-protected')).toBe('inline-flex')
  expect(direct.getByRole('link', { name: /builder/ }).textContent).toContain('working')
  // The open chat is marked.
  expect(groups.getByRole('link', { name: /Team room/ }).getAttribute('aria-current')).toBe('page')
})

test('search filters by name and says so when nothing matches', async () => {
  open('/b')
  const chats = await list()
  await within(chats).findByRole('link', { name: /Feed crew/ })
  const box = within(chats).getByRole('searchbox', { name: 'Search chats' })
  fireEvent.change(box, { target: { value: 'feed' } })
  expect(within(chats).queryByRole('link', { name: /Team room/ })).toBeNull()
  expect(within(chats).queryByRole('heading', { name: 'Direct' })).toBeNull()
  fireEvent.change(box, { target: { value: 'zzz' } })
  expect(within(chats).getByRole('status').textContent).toContain('No chat matches')
})

test('selecting a chat opens it at its address', async () => {
  const router = open('/b')
  const chats = await list()
  fireEvent.click(await within(chats).findByRole('link', { name: /Feed crew/ }))
  await waitFor(() => expect(router.state.location.search).toBe('?room=feed'))
  fireEvent.click(within(await list()).getByRole('link', { name: /builder/ }))
  await waitFor(() => expect(router.state.location.search).toBe('?with=builder'))
})

test('the list folds into a rail, unfolds again, and remembers the choice', async () => {
  open('/b')
  const chats = await list()
  await within(chats).findByRole('link', { name: /Feed crew/ })
  fireEvent.click(within(chats).getByRole('button', { name: 'Fold the chat list' }))
  const rail = screen.getByRole('complementary', { name: 'Chats, folded' })
  expect(within(rail).getByRole('link', { name: 'Feed crew' })).toBeDefined()
  expect(within(rail).getByRole('link', { name: 'reviewer, needs you' })).toBeDefined()
  expect(window.localStorage.getItem('score.chats.folded')).toBe('1')
  fireEvent.click(within(rail).getByRole('button', { name: 'Show the chat list' }))
  expect(screen.getByRole('complementary', { name: 'Chats' })).toBeDefined()
  expect(window.localStorage.getItem('score.chats.folded')).toBe('0')
})

test('a folded list stays folded on the next visit, and a blocked storage does not break it', async () => {
  window.localStorage.setItem('score.chats.folded', '1')
  open('/b')
  expect(await screen.findByRole('complementary', { name: 'Chats, folded' })).toBeDefined()
  cleanup()
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('blocked')
  })
  open('/b')
  expect(await screen.findByRole('complementary', { name: 'Chats' })).toBeDefined()
  vi.restoreAllMocks()
})

test('the chat bar names the owner, members and workspace; Info is the panel by default and Chat info closes it', async () => {
  open('/b?room=feed')
  const header = await screen.findByRole('group', { name: 'Feed crew, chat header' })
  expect(header.textContent).toContain('Owner lead')
  expect(header.textContent).toContain('2 members')
  await waitFor(() => expect(header.textContent).toContain('workspace activity-feed'))

  // The panel opens on Info (the mock-up's 300px column).
  const button = screen.getByRole('button', { name: 'Chat info' })
  expect(button.getAttribute('aria-pressed')).toBe('true')
  const info = await screen.findByLabelText('Feed crew, chat info')
  const members = within(within(info).getByRole('heading', { name: 'Members' }).parentElement!)
  expect(members.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
    'leadowner',
    'builder',
  ])
  await waitFor(() => expect(within(info).getByText('activity-feed · /code/feed')).toBeDefined())
  const topics = within(within(info).getByRole('heading', { name: 'Topics' }).parentElement!)
  const topic = await topics.findByRole('link', { name: /Swap polling for a socket/ })
  expect(topic.getAttribute('href')).toBe('/b?room=feed&job=j-feed')

  // Closing the panel gives the chat the full width; Chat info brings it back.
  fireEvent.click(button)
  expect(button.getAttribute('aria-pressed')).toBe('false')
  expect(document.querySelector('.bold-sidecol')?.hasAttribute('hidden')).toBe(true)
  fireEvent.click(button)
  expect(button.getAttribute('aria-pressed')).toBe('true')
})

test('the team room has a header too', async () => {
  open('/b')
  const header = await screen.findByRole('group', { name: 'Team room, chat header' })
  expect(header.textContent).toContain('Owner lead')
  expect(header.textContent).toContain('3 members')
})

test('on a phone the list is the first screen; a chat opens full screen and Back returns to the list', async () => {
  phone = true
  const router = open('/b')
  const chats = await list()
  expect(screen.queryByRole('complementary', { name: 'Side panel' })).toBeNull()
  expect(within(chats).queryByRole('button', { name: 'Fold the chat list' })).toBeNull()
  fireEvent.click(await within(chats).findByRole('link', { name: /Team room/ }))
  await waitFor(() => expect(router.state.location.search).toBe('?open=1'))
  fireEvent.click(await screen.findByRole('button', { name: 'Back to chats' }))
  await waitFor(() => expect(router.state.location.search).toBe(''))
  expect(await list()).toBeDefined()

  fireEvent.click(await within(await list()).findByRole('link', { name: /builder/ }))
  await waitFor(() => expect(router.state.location.search).toBe('?with=builder'))
  fireEvent.click(await screen.findByRole('button', { name: 'Back to chats' }))
  await waitFor(() => expect(router.state.location.search).toBe(''))
  expect(await list()).toBeDefined()
})

test('a one-to-one is the chat view: the agent’s header in the chat column and its Info in the panel', async () => {
  open('/b?with=builder')
  await screen.findByPlaceholderText('Message builder privately')
  const heading = await screen.findByRole('heading', { name: 'builder' })
  const bar = heading.closest('.bold-chat-bar') as HTMLElement
  expect(bar.textContent).toContain('Direct · working')
  expect(bar.textContent).toContain('Only you and builder see this')
  // The chat column holds the conversation and the composer; the old side-panel one-to-one is gone.
  expect(screen.getByRole('region', { name: 'Chat with builder' })).toBeDefined()
  expect(screen.getByPlaceholderText('Message builder privately')).toBeDefined()
  const info = await screen.findByLabelText('builder, chat info')
  expect(within(info).getByRole('heading', { name: 'Chats' })).toBeDefined()
  expect(await within(info).findByRole('link', { name: /Sockets or polling/ })).toBeDefined()
  expect(screen.queryByRole('tab', { name: 'Results' })).toBeNull()
  // Chat info closes and reopens the panel, as in a group chat.
  const button = within(bar).getByRole('button', { name: 'Chat info' })
  expect(button.getAttribute('aria-pressed')).toBe('true')
  fireEvent.click(button)
  expect(document.querySelector('.bold-sidecol')?.hasAttribute('hidden')).toBe(true)
})

test('on a phone a one-to-one opens in the chat view with the Info sheet one tap away', async () => {
  phone = true
  open('/b?with=builder')
  const info = await screen.findByRole('button', { name: 'Chat info' })
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.click(info)
  expect(await screen.findByLabelText('builder, chat info')).toBeDefined()
})

test('on a phone every group chat has the back bar, and the chat opens on its conversation with the title once', async () => {
  phone = true
  const router = open('/b?room=feed')
  const back = await screen.findByRole('button', { name: 'Back to chats' })
  expect(screen.getAllByText('Feed crew').length).toBe(1)
  expect(screen.queryByRole('button', { name: 'Back to jobs' })).toBeNull()
  fireEvent.click(back)
  await waitFor(() => expect(router.state.location.search).toBe(''))
  expect(await list()).toBeDefined()
})

test('on a phone an archived chat says so in its bar, with Unarchive right there', async () => {
  phone = true
  feedArchived = true
  open('/b?room=feed')
  await screen.findByRole('button', { name: 'Back to chats' })
  expect(await screen.findByText('Archived')).toBeDefined()
  expect(screen.getByRole('button', { name: 'Unarchive' })).toBeDefined()
})

// 3.24.0: was 'on a phone, picking a room from the job list opens that room’s conversation, not its job list'. The job list
// and its title switcher are gone: the room ⋯ menu opens the older/imported/elsewhere list, and a pick opens that chat.
test('on a phone, the room menu’s older-chats list opens that room’s conversation', async () => {
  phone = true
  const router = open('/b?job=j-feed')
  expect(await screen.findByRole('button', { name: 'Back to chats' })).toBeDefined()
  expect(screen.queryByRole('button', { name: 'Open side panel' })).toBeNull()
  fireEvent.click(await screen.findByRole('button', { name: 'Room menu' }))
  fireEvent.click(
    await screen.findByRole('menuitem', { name: /Older, imported and elsewhere chats/ }),
  )
  fireEvent.click(await screen.findByRole('option', { name: /Feed crew/ }))
  await waitFor(() => expect(router.state.location.search).toBe('?room=feed'))
  expect(await screen.findByRole('button', { name: 'Back to chats' })).toBeDefined()
  expect(screen.queryByRole('region', { name: 'Jobs' })).toBeNull()
})

test('on a phone, an old ?jobs=1 link lands on the chat with Info open at Topics', async () => {
  phone = true
  const router = open('/b?jobs=1')
  expect(await screen.findByRole('heading', { name: 'Topics' })).toBeDefined()
  expect(await screen.findByRole('button', { name: 'Back to chats' })).toBeDefined()
  await waitFor(() => expect(router.state.location.search).toBe(''))
  expect(screen.queryByRole('region', { name: 'All topics' })).toBeNull()
  expect(document.getElementById('bold-side-panel')?.hasAttribute('hidden')).toBe(false)
  expect(screen.getByRole('button', { name: 'New topic' })).toBeDefined()
})
