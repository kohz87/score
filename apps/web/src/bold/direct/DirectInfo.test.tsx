import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  agents,
  disposeRoomTest,
  jsonResponse,
  makeJob,
  makeMessage,
  mockFetch,
  renderInRoom,
  room as teamRoom,
} from '../room/room-test-utils.tsx'
import { DirectInfo } from './DirectInfo.tsx'
import { openAllInfoSections, resetInfoFolds } from '../chats/info-test-utils.ts'

// The sections start folded or open by kind (3.27.1); these tests read inside all of them.
beforeEach(openAllInfoSections)

afterEach(() => {
  resetInfoFolds()
  disposeRoomTest()
  vi.unstubAllGlobals()
})

const builder = agents[1]!
const directRoom = {
  ...teamRoom,
  id: 'direct-builder',
  name: 'builder',
  kind: 'direct' as const,
  leadAgentId: 'builder',
  members: ['builder'],
  role: 'direct' as const,
  routing: 'mentions' as const,
}
const older = makeJob({
  id: 'chat-old',
  roomId: directRoom.id,
  title: 'The cursor bug',
  state: 'done',
  lastMessageAt: '2026-10-21T13:14:00.000Z',
  summary: 'Cursor is (created_at, id).',
  createdAt: '2026-10-21T13:12:00.000Z',
})
const newer = makeJob({
  id: 'chat-new',
  roomId: directRoom.id,
  title: 'Websockets or server-sent events',
  lastMessageAt: '2026-10-24T11:14:00.000Z',
  summary: 'Sockets go both ways.',
  createdAt: '2026-10-24T11:12:00.000Z',
})
const teamJob = makeJob({ id: 'team-job', roomId: teamRoom.id, title: 'Release notes 2.4' })

type Post = { url: string; body: unknown }

function stub(
  chats = [newer, older],
  extra?: (url: string) => Response | undefined,
  room: typeof directRoom = directRoom,
) {
  const posts: Post[] = []
  vi.stubGlobal(
    'fetch',
    mockFetch((url, init) => {
      if (init.method !== 'POST') {
        const made = extra?.(url)
        if (made) return made
      }
      if (init.method === 'POST') {
        posts.push({ url, body: init.body ? JSON.parse(String(init.body)) : null })
        if (url.endsWith('/chats'))
          return jsonResponse(
            makeJob({ id: 'chat-made', roomId: directRoom.id, title: 'New chat' }),
            201,
          )
        if (url.endsWith('/jobs'))
          return jsonResponse(makeJob({ id: 'moved', roomId: teamRoom.id }), 201)
        return jsonResponse({ message: makeMessage({ id: 'posted' }) }, 201)
      }
      if (url === '/api/agents/builder/direct') return jsonResponse({ asOfSeq: 1, room, chats })
      if (url === '/api/team-room')
        return jsonResponse({ asOfSeq: 1, room: teamRoom, jobs: [teamJob] })
      if (url.startsWith(`/api/rooms/${teamRoom.id}/jobs`))
        return jsonResponse({ asOfSeq: 1, items: [teamJob] })
      if (url === '/api/workspaces')
        return jsonResponse({
          workspaces: [
            {
              id: 'ws-1',
              name: 'activity-feed',
              path: '/work/activity-feed',
              agentIds: [],
              roomIds: [],
            },
          ],
        })
      return jsonResponse({ asOfSeq: 0, items: [] })
    }),
  )
  return posts
}

function renderInfo(chatId: string | null = 'chat-new', onNavigate?: () => void) {
  return renderInRoom(
    <DirectInfo agent={builder} agents={agents} chatId={chatId} onNavigate={onNavigate} />,
    ['/b?with=builder'],
  )
}

test('Info names the agent and its state, links its page and its memory, and Knowledge', async () => {
  stub()
  renderInfo()
  await screen.findByText('The cursor bug')
  const info = screen.getByLabelText('builder, chat info')
  expect(within(info).getByText('working')).toBeTruthy()
  expect(within(info).getByText('Builds features')).toBeTruthy()
  expect(within(info).getByRole('link', { name: 'Open builder’s page' }).getAttribute('href')).toBe(
    '/b/agents/builder',
  )
  expect(within(info).getByRole('link', { name: 'See its memory' }).getAttribute('href')).toBe(
    '/b/agents/builder#agent-memory',
  )
  expect(within(info).getByRole('link', { name: 'Open Knowledge' }).getAttribute('href')).toBe(
    '/b/knowledge',
  )
  expect(within(info).getByRole('link', { name: "Look at builder's screen" })).toBeTruthy()
})

test('a Hermes agent’s Chat info has no plan quota section', async () => {
  stub()
  renderInfo()
  await screen.findByText('The cursor bug')
  expect(screen.queryByRole('button', { name: /Quota/ })).toBeNull()
  expect(screen.queryByText(/Shared with every agent on the same/)).toBeNull()
})

test('Info shows the room’s workspace, or says none is set', async () => {
  stub([newer], undefined, { ...directRoom, workspaceId: 'ws-1' })
  const view = renderInfo()
  expect(await screen.findByText('activity-feed · /work/activity-feed')).toBeTruthy()
  view.unmount()
  stub()
  renderInfo()
  expect(await screen.findByText('None set.')).toBeTruthy()
})

test('the chats are listed as topics, newest first, the current one marked', async () => {
  stub()
  renderInfo('chat-old')
  await screen.findByText('The cursor bug')
  const links = screen
    .getAllByRole('link')
    .filter((link) => link.getAttribute('href')?.includes('chat='))
  expect(links.map((link) => link.getAttribute('href'))).toEqual([
    '/b?with=builder&chat=chat-new',
    '/b?with=builder&chat=chat-old',
  ])
  expect(links[1]!.getAttribute('aria-current')).toBe('true')
  expect(links[0]!.getAttribute('aria-current')).toBeNull()
  expect(screen.getByText('Sockets go both ways.')).toBeTruthy()
})

test('with no chat in the address the newest open chat is the current one', async () => {
  stub()
  renderInfo(null)
  await screen.findByText('The cursor bug')
  const current = screen.getByRole('link', { name: /Websockets or server-sent events/ })
  expect(current.getAttribute('aria-current')).toBe('true')
})

test('an empty default thread is not listed among the chats', async () => {
  stub([
    newer,
    makeJob({
      id: 'plumbing',
      roomId: directRoom.id,
      title: 'builder',
      isDefault: true,
      messageCount: 0,
    }),
  ])
  renderInfo()
  await screen.findByText('Websockets or server-sent events')
  expect(
    screen.getAllByRole('link').filter((link) => link.getAttribute('href')?.includes('chat=')),
  ).toHaveLength(1)
})

test('chats search by title and summary, and New chat starts one', async () => {
  const posts = stub()
  renderInfo()
  await screen.findByText('The cursor bug')
  const search = screen.getByRole('searchbox', { name: 'Search chats' })
  expect(search.getAttribute('placeholder')).toBe('Search titles and summaries')
  fireEvent.change(search, { target: { value: 'created_at' } })
  expect(screen.getByText('The cursor bug')).toBeTruthy()
  expect(screen.queryByText('Websockets or server-sent events')).toBeNull()
  fireEvent.change(search, { target: { value: 'nothing here' } })
  expect(screen.getByText('No chats match “nothing here”.')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'New chat with builder' }))
  await waitFor(() =>
    expect(posts.some((post) => post.url === '/api/agents/builder/chats')).toBe(true),
  )
})

test('leaving through a link closes the phone sheet', async () => {
  stub()
  const left = vi.fn()
  renderInfo('chat-new', left)
  fireEvent.click(await screen.findByRole('link', { name: /The cursor bug/ }))
  expect(left).toHaveBeenCalled()
})

test('Add someone says what leaves, then starts the job and asks both agents', async () => {
  const posts = stub()
  renderInfo()
  fireEvent.click(await screen.findByRole('button', { name: 'Add someone' }))
  const dialog = await screen.findByRole('dialog', { name: 'Add someone to this one-to-one' })
  expect(dialog.getAttribute('data-protected')).toBe('block')
  expect(within(dialog).queryByRole('button', { name: 'Add builder' })).toBeNull()
  fireEvent.click(within(dialog).getByRole('button', { name: 'Add reviewer' }))
  // Nothing has left yet: the dialog names the job and the summary first.
  expect(posts).toHaveLength(0)
  expect(within(dialog).getByText('Websockets or server-sent events')).toBeTruthy()
  expect(within(dialog).getByText(/Sockets go both ways\./)).toBeTruthy()
  fireEvent.click(within(dialog).getByRole('button', { name: 'Add reviewer and share a summary' }))
  await waitFor(() =>
    expect(posts.find((post) => post.url === '/api/rooms/room-1/messages')).toBeDefined(),
  )
  expect(posts[0]).toMatchObject({
    url: '/api/rooms/room-1/jobs',
    body: { title: 'Websockets or server-sent events' },
  })
  expect(posts.find((post) => post.url === '/api/rooms/room-1/messages')?.body).toMatchObject({
    to: ['builder', 'reviewer'],
    jobId: 'moved',
    refs: [{ jobId: 'chat-new' }],
  })
})

test('when the hand-off message fails the job is kept and only the message is retried', async () => {
  const posts = stub()
  const original = globalThis.fetch
  let fail = true
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === '/api/rooms/room-1/messages' && init?.method === 'POST' && fail) {
      posts.push({ url: String(input), body: JSON.parse(String(init.body)) })
      return Promise.resolve(jsonResponse({ code: 'boom', message: 'No.' }, 500))
    }
    return original(input, init)
  })
  renderInfo()
  fireEvent.click(await screen.findByRole('button', { name: 'Add someone' }))
  const dialog = await screen.findByRole('dialog', { name: 'Add someone to this one-to-one' })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Add reviewer' }))
  fireEvent.click(within(dialog).getByRole('button', { name: 'Add reviewer and share a summary' }))
  expect((await within(dialog).findByRole('alert')).textContent).toContain('didn’t send')
  fail = false
  fireEvent.click(within(dialog).getByRole('button', { name: 'Retry the message to reviewer' }))
  await waitFor(() =>
    expect(posts.filter((post) => post.url === '/api/rooms/room-1/jobs')).toHaveLength(1),
  )
})

const docsTeam = {
  ...teamRoom,
  id: 'room-docs',
  name: 'Docs team',
  members: ['lead', 'builder'],
  everyone: false,
}
const twoTeams = (url: string) => {
  if (url === '/api/team-rooms')
    return jsonResponse({ asOfSeq: 1, items: [{ ...teamRoom, everyone: true }, docsTeam] })
  if (url.startsWith(`/api/rooms/${docsTeam.id}/jobs`))
    return jsonResponse({ asOfSeq: 1, items: [] })
  return undefined
}

test('with two team rooms Add someone starts the job in the chosen team and offers only its members', async () => {
  const posts = stub([newer, older], twoTeams)
  renderInfo()
  fireEvent.click(await screen.findByRole('button', { name: 'Add someone' }))
  const dialog = await screen.findByRole('dialog', { name: 'Add someone to this one-to-one' })
  fireEvent.change(await within(dialog).findByRole('combobox'), {
    target: { value: 'room-docs' },
  })
  // reviewer is not in the Docs team, lead is.
  expect(within(dialog).queryByRole('button', { name: 'Add reviewer' })).toBeNull()
  fireEvent.click(within(dialog).getByRole('button', { name: 'Add lead' }))
  expect(within(dialog).getByText(/Starts in Docs team/)).toBeTruthy()
  fireEvent.click(within(dialog).getByRole('button', { name: 'Add lead and share a summary' }))
  await waitFor(() =>
    expect(posts.find((post) => post.url === '/api/rooms/room-docs/messages')).toBeDefined(),
  )
  expect(posts[0]?.url).toBe('/api/rooms/room-docs/jobs')
})

test('with one team room Add someone shows no team choice', async () => {
  stub()
  renderInfo()
  fireEvent.click(await screen.findByRole('button', { name: 'Add someone' }))
  const dialog = await screen.findByRole('dialog', { name: 'Add someone to this one-to-one' })
  expect(within(dialog).queryByRole('combobox')).toBeNull()
})

test('Escape closes Add someone and returns focus to the button that opened it', async () => {
  stub()
  renderInfo()
  const open = await screen.findByRole('button', { name: 'Add someone' })
  open.focus()
  fireEvent.click(open)
  await screen.findByRole('dialog', { name: 'Add someone to this one-to-one' })
  fireEvent.keyDown(document.body, { key: 'Escape' })
  await waitFor(() =>
    expect(screen.queryByRole('dialog', { name: 'Add someone to this one-to-one' })).toBeNull(),
  )
  expect(document.activeElement).toBe(open)
})
