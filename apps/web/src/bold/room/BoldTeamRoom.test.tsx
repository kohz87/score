import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { useSearchParams } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { Approval, OutsideSession, Room } from '@score/contract'
import {
  agents,
  disposeRoomTest,
  jsonResponse,
  makeJob,
  makeMessage,
  mockFetch,
  renderInRoom,
  room,
  openOtherRooms,
} from './room-test-utils.tsx'
import { BoldTeamRoom } from './BoldTeamRoom.tsx'
import { StartJobContext, type StartJobOptions } from '../BoldStartJob.tsx'
import { JobUndoToast } from './JobUndoToast.tsx'
import { resetJobUndo } from './job-undo.ts'

beforeEach(() => {
  window.localStorage.clear()
  resetJobUndo()
})

afterEach(() => {
  disposeRoomTest()
  vi.unstubAllGlobals()
})

const olderRoom: Room = {
  ...room,
  id: 'room-old',
  name: '#activity-feed',
  leadAgentId: null,
  role: 'room',
  routing: 'mentions',
}

const importedRoom: Room = {
  ...olderRoom,
  id: 'room-imported',
  name: '#telegram-plan #imported',
  importedFrom: {
    agentId: 'lead',
    sessionId: 'ext-telegram-1',
    source: 'telegram',
    label: 'Telegram',
    continued: null,
  },
}

const outsideSession: OutsideSession = {
  id: 'ext-telegram-1',
  agentId: 'lead',
  source: 'telegram',
  sourceLabel: 'Telegram',
  title: 'Plan the launch checklist',
  startedAt: '2026-10-23T08:00:00.000Z',
  messageCount: 4,
  busy: false,
  roomId: null,
}

function stubRoom(
  jobs = [makeJob({ unread: 2 })],
  options: {
    older?: boolean
    imported?: boolean
    outside?: OutsideSession[]
    approvals?: Approval[]
    versions?: unknown[]
  } = {},
) {
  const fetchMock = mockFetch((url, init) => {
    const parsed = new URL(url, 'http://x')
    if (parsed.pathname === '/api/team-room') return jsonResponse({ asOfSeq: 1, room, jobs })
    if (parsed.pathname === '/api/tasks')
      return jsonResponse({
        asOfSeq: 1,
        columns: { planned: [], working: [], in_review: [], needs_you: [], done: [] },
      })
    if (parsed.pathname === '/api/rooms')
      return jsonResponse({
        asOfSeq: 1,
        rooms: options.older ? [olderRoom] : options.imported ? [importedRoom] : [],
        directs: [],
        projects: [],
      })
    if (parsed.pathname === '/api/outside-sessions')
      return jsonResponse({ items: options.outside ?? [], unavailable: [] })
    if (parsed.pathname === '/api/rooms/room-old')
      return jsonResponse({ asOfSeq: 1, room: olderRoom, filesInPlay: [], learned: [] })
    if (parsed.pathname === '/api/rooms/room-old/jobs')
      return jsonResponse({
        asOfSeq: 1,
        items: [
          makeJob({
            id: 'job-old',
            roomId: olderRoom.id,
            title: olderRoom.name,
            isDefault: true,
            holderAgentId: null,
          }),
        ],
      })
    if (parsed.pathname === '/api/rooms/room-old/messages' && init.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { text?: string }
      return jsonResponse({
        message: {
          id: 'message-old-sent',
          roomId: olderRoom.id,
          jobId: 'job-old',
          author: { kind: 'you' },
          to: ['builder'],
          parts: [{ kind: 'text', text: body.text }],
          createdAt: '2026-10-24T10:20:00.000Z',
          streaming: false,
          refs: [],
        },
        routedTo: ['builder'],
        command: null,
      })
    }
    if (parsed.pathname === '/api/rooms/room-old/messages')
      return jsonResponse({
        asOfSeq: 1,
        items: [],
        nextCursor: null,
        jobId: parsed.searchParams.get('jobId') ?? 'job-old',
      })
    if (parsed.pathname === '/api/rooms/room-old/pins') return jsonResponse({ items: [] })
    if (parsed.pathname === '/api/rooms/room-old/versions')
      return jsonResponse({ asOfSeq: 1, items: [] })
    if (parsed.pathname === '/api/rooms/room-1/jobs')
      return jsonResponse({ asOfSeq: 1, items: jobs })
    if (parsed.pathname === '/api/rooms/room-1/messages')
      return jsonResponse({
        asOfSeq: 1,
        items: [],
        nextCursor: null,
        jobId: parsed.searchParams.get('jobId'),
      })
    if (parsed.pathname === '/api/rooms/room-1/pins') return jsonResponse({ items: [] })
    if (parsed.pathname === '/api/rooms/room-1/versions')
      return jsonResponse({ asOfSeq: 1, items: options.versions ?? [] })
    if (parsed.pathname === '/api/approvals')
      return jsonResponse({ asOfSeq: 1, items: options.approvals ?? [], nextCursor: null })
    if (parsed.pathname === '/api/commands') return jsonResponse({ items: [] })
    if (parsed.pathname.startsWith('/api/jobs/')) return jsonResponse({ asOfSeq: 1, items: [] })
    if (parsed.pathname === '/api/tasks')
      return jsonResponse({
        asOfSeq: 1,
        columns: { planned: [], working: [], in_review: [], needs_you: [], done: [] },
      })
    if (parsed.pathname.startsWith('/api/rooms/room-old'))
      return jsonResponse({ asOfSeq: 1, items: [] })
    return jsonResponse({ asOfSeq: 1, items: [] })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function ParamsProbe() {
  const [params] = useSearchParams()
  return <span data-testid="params">{params.toString()}</span>
}

/** The divider that opens a topic, found by the title it carries. */
function topicDivider(title: string) {
  const found = screen
    .getAllByRole('separator')
    .find((item) => item.getAttribute('aria-label')?.startsWith(`Topic: ${title},`))
  if (!found) throw new Error(`No divider for the topic ${title}`)
  return found
}

/** One job per chat (3.28.0): the job bar carries the job's ⋯ menu now that its divider is gone. */
function jobBar(name: 'Current job' | 'Past job' = 'Current job') {
  return screen.getByRole('region', { name })
}

function lastRequest(fetchMock: ReturnType<typeof stubRoom>, path: string, method: string) {
  return fetchMock.mock.calls.find(([url, init]) => String(url) === path && init?.method === method)
}

test('a slash command handed over in the URL is loaded into the room composer and removed from the URL', async () => {
  stubRoom()
  renderInRoom(
    <>
      <BoldTeamRoom agents={agents} />
      <ParamsProbe />
    </>,
    ['/b?command=assign'],
  )
  const composer = await screen.findByRole(
    'combobox',
    { name: /^Message Team room/ },
    { timeout: 4000 },
  )
  await waitFor(() => expect((composer as HTMLTextAreaElement).value).toBe('/assign '), {
    timeout: 4000,
  })
  await waitFor(() => expect(screen.getByTestId('params').textContent).not.toContain('command'), {
    timeout: 4000,
  })
})

test('@ in the room offers only agents that can take a message, not removed ones (3.7.10, owner)', async () => {
  stubRoom()
  const removed = {
    ...agents[1]!,
    id: 'gone',
    name: 'gone',
    lifecycle: {
      state: 'removed' as const,
      incarnationId: '6f9619ff-8b86-4d11-b42d-00c04fc964ff',
      operationId: null,
    },
  }
  renderInRoom(<BoldTeamRoom agents={[...agents, removed]} />, ['/b'])
  const composer = await screen.findByRole(
    'combobox',
    { name: /^Message Team room/ },
    { timeout: 4000 },
  )
  fireEvent.change(composer, { target: { value: '@' } })
  const list = await screen.findByRole('listbox', { name: 'Agents' })
  const offered = Array.from(list.querySelectorAll('[role="option"]')).map(
    (option) => option.textContent ?? '',
  )
  expect(offered.some((text) => text.includes(agents[1]!.id))).toBe(true)
  expect(offered.some((text) => text.includes('gone'))).toBe(false)
})

const phoneApproval: Approval = {
  id: 'approval-phone',
  origin: 'score-run',
  phase: 'human_pending',
  status: 'pending',
  actionable: true,
  linkedTo: null,
  agentId: 'builder',
  title: 'May I install a package?',
  command: 'npm install ws@8',
  cwd: '~/app',
  description: 'The websocket feed needs ws.',
  choices: ['once', 'session', 'always', 'deny'],
  createdAt: '2026-10-24T09:03:00.000Z',
  expiresAt: null,
  decision: null,
  delivery: 'none',
  blocking: null,
  refs: [],
}

test('an older phone room with no messages still opens its chat, not the starter', async () => {
  stubRoom([makeJob({ id: 'job-1', title: 'Activity feed' })], { older: true })
  renderInRoom(<BoldTeamRoom agents={agents} phone />, ['/b?room=room-old'])

  expect(await screen.findByRole('button', { name: 'Back to chats' })).toBeDefined()
  expect(screen.getByRole('combobox', { name: /^Message #activity-feed/ })).toBeDefined()
  expect(screen.queryByRole('heading', { name: 'Your team is ready. What first?' })).toBeNull()
})

test('an older room opens straight into its phone chat and Back goes to the chat list', async () => {
  const back = vi.fn()
  stubRoom([makeJob({ id: 'job-1', title: 'Activity feed' })], { older: true })
  renderInRoom(
    <>
      <BoldTeamRoom agents={agents} phone onBackToChats={back} />
      <ParamsProbe />
    </>,
    ['/b?room=room-old'],
  )

  expect(await screen.findByRole('button', { name: 'Back to chats' })).toBeDefined()
  expect(
    screen.getByText('#activity-feed', { selector: '.bold-chat-phone-id strong' }),
  ).toBeDefined()
  expect(screen.getByRole('combobox', { name: /^Message #activity-feed/ })).toBeDefined()
  expect(screen.queryByRole('heading', { name: 'Jobs' })).toBeNull()

  fireEvent.click(screen.getByRole('button', { name: 'Back to chats' }))
  expect(back).toHaveBeenCalledTimes(1)
})

test('a fresh team room shows board 09 and a starter fills the composer', async () => {
  stubRoom([])
  renderInRoom(<BoldTeamRoom agents={agents} />, ['/b'])
  expect(
    await screen.findByRole('heading', { name: 'Your team is ready. What first?' }),
  ).toBeDefined()
  expect(screen.queryByRole('tablist', { name: 'Jobs' })).toBeNull()
  expect(screen.queryByText('Show deleted messages')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: /Build something, reviewed/ }))
  const composer = screen.getByRole('combobox', { name: /^Message Team room/ })
  await waitFor(() =>
    expect((composer as HTMLTextAreaElement).value).toBe(
      'Build a small feature and have reviewer check it.',
    ),
  )
})

test('a fresh team room still shows an approval that names no job', async () => {
  stubRoom([], { approvals: [phoneApproval] })
  renderInRoom(<BoldTeamRoom agents={agents} />, ['/b'])
  expect(
    await screen.findByRole('heading', { name: 'Your team is ready. What first?' }),
  ).toBeDefined()
  expect(
    await screen.findByRole('article', { name: /Needs you: May I install a package/ }),
  ).toBeDefined()
})

test('an imported room is listed under Imported chats, not as an older room', async () => {
  stubRoom([makeJob()], { imported: true })
  renderInRoom(<BoldTeamRoom agents={agents} />, ['/b'])

  await openOtherRooms()
  const picker = await screen.findByRole('listbox', { name: 'Rooms and chats elsewhere' })
  expect(picker.textContent).toContain('Imported chats')
  expect(picker.textContent).toContain('Imported from Telegram · read-write')
  expect(picker.textContent).toContain('#telegram-plan')
})

test('the room dropdown closes when Tab moves focus outside it', async () => {
  stubRoom([makeJob()], { older: true })
  renderInRoom(<BoldTeamRoom agents={agents} />, ['/b'])

  await openOtherRooms()
  await screen.findByRole('listbox', { name: 'Rooms and chats elsewhere' })
  await waitFor(() =>
    expect(screen.getByRole('option', { name: /Team room/ })).toBe(document.activeElement),
  )
  fireEvent.focusIn(document.body)
  expect(screen.queryByRole('listbox', { name: 'Rooms and chats elsewhere' })).toBeNull()
})

test('an imported room opens read-write and sends through the normal room route', async () => {
  const fetchMock = mockFetch((url, init) => {
    const parsed = new URL(url, 'http://x')
    if (parsed.pathname === '/api/team-room') return jsonResponse({ asOfSeq: 1, room, jobs: [] })
    if (parsed.pathname === '/api/rooms')
      return jsonResponse({ asOfSeq: 1, rooms: [importedRoom], directs: [], projects: [] })
    if (parsed.pathname === '/api/rooms/room-imported')
      return jsonResponse({
        asOfSeq: 1,
        room: importedRoom,
        filesInPlay: [],
        learned: [],
      })
    if (parsed.pathname === '/api/rooms/room-imported/jobs')
      return jsonResponse({
        asOfSeq: 1,
        items: [
          makeJob({
            id: 'job-imported',
            roomId: importedRoom.id,
            title: importedRoom.name,
            isDefault: true,
          }),
        ],
      })
    if (parsed.pathname === '/api/rooms/room-imported/messages' && init.method === 'POST')
      return jsonResponse({
        message: {
          id: 'message-imported-sent',
          roomId: importedRoom.id,
          jobId: 'job-imported',
          author: { kind: 'you' },
          to: ['builder'],
          parts: [{ kind: 'text', text: JSON.parse(String(init.body)).text }],
          createdAt: '2026-10-24T10:20:00.000Z',
          streaming: false,
          refs: [],
        },
        routedTo: ['builder'],
        command: null,
      })
    if (parsed.pathname === '/api/rooms/room-imported/messages')
      return jsonResponse({ asOfSeq: 1, items: [], nextCursor: null, jobId: 'job-imported' })
    if (parsed.pathname === '/api/rooms/room-imported/pins') return jsonResponse({ items: [] })
    if (parsed.pathname === '/api/rooms/room-imported/versions')
      return jsonResponse({ asOfSeq: 1, items: [] })
    return jsonResponse({ asOfSeq: 1, items: [] })
  })
  vi.stubGlobal('fetch', fetchMock)
  renderInRoom(<BoldTeamRoom agents={agents} />, ['/b'])

  await openOtherRooms()
  fireEvent.click(await screen.findByRole('option', { name: /#telegram-plan/ }))
  await waitFor(() =>
    expect(screen.getByRole('heading', { name: /^#telegram-plan #imported/ })).toBeDefined(),
  )
  const composer = await screen.findByRole('combobox', { name: /^Message #telegram-plan/ })
  fireEvent.change(composer, { target: { value: '@builder Continue here?' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))

  await waitFor(() => {
    const sent = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url) === '/api/rooms/room-imported/messages' && init?.method === 'POST',
    )
    expect(sent).toBeDefined()
  })
  expect(
    fetchMock.mock.calls.some(
      ([url]) => String(url) === '/api/rooms/room-imported/continue-session',
    ),
  ).toBe(false)
})

test('Elsewhere lists the agents’ own sessions as read-only chats to open', async () => {
  stubRoom([makeJob()], { outside: [outsideSession] })
  const opened = vi.fn()
  renderInRoom(<BoldTeamRoom agents={agents} onOpenElsewhere={opened} />, ['/b'])

  await openOtherRooms()
  const picker = await screen.findByRole('listbox', { name: 'Rooms and chats elsewhere' })
  expect(picker.textContent).toContain('Elsewhere · the agents’ own chats outside Score')
  const row = await screen.findByRole('option', { name: /Plan the launch checklist/ })
  expect(row.textContent).toContain('lead · Telegram')
  expect(row.textContent).toContain('Plan the launch checklist · 4 messages')
  fireEvent.click(row)

  expect(opened).toHaveBeenCalledWith(outsideSession)
  expect(screen.queryByRole('listbox', { name: 'Rooms and chats elsewhere' })).toBeNull()
})

test('the selected job’s menu offers rename, close, share, export and delete, but not for the room’s own thread', async () => {
  stubRoom([makeJob({ id: 'job-activity', title: 'Activity feed' })])
  renderInRoom(<BoldTeamRoom agents={agents} />, ['/b?job=job-activity'])

  fireEvent.click(await screen.findByRole('button', { name: 'Job menu' }))
  const menu = await screen.findByRole('menu', { name: 'Activity feed actions' })
  expect(menu.textContent).toContain('Rename…')
  expect(menu.textContent).toContain('Close')
  expect(menu.textContent).toContain('Share a read-only link')
  expect(menu.textContent).toContain('Export the whole room as Markdown')
  expect(menu.textContent).toContain('Delete job')
  expect(screen.getAllByRole('menuitem').every((item) => item.classList.contains('mi'))).toBe(true)
  fireEvent.click(screen.getByRole('menuitem', { name: 'Share a read-only link' }))
  const dialog = await screen.findByRole('dialog')
  expect(dialog.textContent).toContain('Share Activity feed')
  expect(dialog.textContent).toContain('the job’s messages')
})

test('a close while work is running explains the 409 and offers Stop', async () => {
  const fetchMock = stubRoom([makeJob({ id: 'job-activity', title: 'Activity feed' })])
  const fallback = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input)
    if (url === '/api/jobs/job-activity/close' && init?.method === 'POST')
      return jsonResponse(
        {
          error: {
            code: 'conflict',
            message: 'The job is still working. Stop it first, then close it.',
          },
        },
        409,
      )
    if (url === '/api/jobs/job-activity/stop' && init?.method === 'POST')
      return jsonResponse({ ok: true })
    return fallback(input, init)
  })
  renderInRoom(<BoldTeamRoom agents={agents} />, ['/b?job=job-activity'])
  fireEvent.click(await screen.findByRole('button', { name: 'Job menu' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Close' }))
  expect(
    await screen.findByText(/This job is still working\. Stop it first, then close it\./),
  ).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
  await waitFor(() =>
    expect(
      fetchMock.mock.calls.some(([url]) => String(url) === '/api/jobs/job-activity/stop'),
    ).toBe(true),
  )
  expect(await screen.findByText(/Stop sent\. Close or delete the job again/)).toBeDefined()
})

test('a restore failure clears the undo toast and names the reason', async () => {
  const fetchMock = stubRoom([makeJob({ id: 'job-activity', title: 'Activity feed' })])
  const fallback = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input)
    if (url === '/api/jobs/job-activity' && init?.method === 'DELETE')
      return new Response(null, { status: 204 })
    if (url === '/api/jobs/job-activity/restore' && init?.method === 'POST')
      return jsonResponse({ error: { code: 'not_found', message: 'The job is gone.' } }, 404)
    return fallback(input, init)
  })
  renderInRoom(
    <>
      <BoldTeamRoom agents={agents} />
      <JobUndoToast />
    </>,
    ['/b?job=job-activity'],
  )
  fireEvent.click(await screen.findByRole('button', { name: 'Job menu' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete job' }))
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Activity feed' } })
  fireEvent.click(screen.getByRole('button', { name: 'Delete job' }))
  expect(await screen.findByText(/Job deleted/)).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: 'Undo' }))

  expect(await screen.findByText('That job can’t be restored any more')).toBeDefined()
  expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull()
})

test('the default job offers neither rename nor delete', async () => {
  stubRoom([makeJob({ id: 'job-default', title: 'Team room', isDefault: true })])
  renderInRoom(<BoldTeamRoom agents={agents} phone />, ['/b?job=job-default'])
  // The conversation itself has no job tools on a phone: nothing to rename or delete (named jobs keep their menu).
  expect(await screen.findByRole('button', { name: 'Back to chats' })).toBeDefined()
  expect(screen.queryByRole('button', { name: 'Job menu' })).toBeNull()
})

test('a message into a closed job explains the 409, and Reopen resends into that job', async () => {
  let sends = 0
  const fetchMock = stubRoom([makeJob({ id: 'job-activity', title: 'Activity feed' })])
  const fallback = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input)
    if (url === '/api/rooms/room-1/messages' && init?.method === 'POST') {
      sends += 1
      if (sends === 1)
        return jsonResponse(
          { error: { code: 'conflict', message: 'This job is closed. Reopen it first.' } },
          409,
        )
      return jsonResponse({
        message: makeMessage({
          id: 'message-resumed',
          jobId: 'job-activity',
          parts: [{ kind: 'text', text: 'One more change' }],
        }),
        routedTo: ['builder'],
        command: null,
      })
    }
    if (url === '/api/jobs/job-activity/reopen' && init?.method === 'POST')
      return jsonResponse(makeJob({ id: 'job-activity', title: 'Activity feed', state: 'open' }))
    return fallback(input, init)
  })
  renderInRoom(<BoldTeamRoom agents={agents} />, ['/b?job=job-activity'])

  const composer = await screen.findByRole('combobox', { name: /^Message Team room/ })
  fireEvent.change(composer, { target: { value: 'One more change' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  expect(await screen.findByText('This job is closed. Reopen it to write in it.')).toBeDefined()

  fireEvent.click(screen.getByRole('button', { name: 'Reopen' }))
  await waitFor(() => expect(sends).toBe(2))
  const posts = fetchMock.mock.calls.filter(
    ([url, init]) => String(url) === '/api/rooms/room-1/messages' && init?.method === 'POST',
  )
  expect(posts.map(([, init]) => JSON.parse(String(init?.body)).jobId)).toEqual([
    'job-activity',
    'job-activity',
  ])
  expect(new Headers(posts[0]![1]!.headers).get('Idempotency-Key')).toBe(
    new Headers(posts[1]![1]!.headers).get('Idempotency-Key'),
  )
})

test('delete explains a still-working 409 and offers Stop', async () => {
  const fetchMock = stubRoom([makeJob({ id: 'job-activity', title: 'Activity feed' })])
  const fallback = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input)
    if (url === '/api/jobs/job-activity' && init?.method === 'DELETE')
      return jsonResponse(
        {
          error: {
            code: 'conflict',
            message: 'The job is still working. Stop it first, then delete it.',
          },
        },
        409,
      )
    if (url === '/api/jobs/job-activity/stop' && init?.method === 'POST')
      return jsonResponse({ ok: true })
    return fallback(input, init)
  })
  renderInRoom(<BoldTeamRoom agents={agents} />, ['/b?job=job-activity'])
  fireEvent.click(await screen.findByRole('button', { name: 'Job menu' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete job' }))
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Activity feed' } })
  fireEvent.click(screen.getByRole('button', { name: 'Delete job' }))
  expect(await screen.findByText(/still working\. Stop it first, then delete it/)).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
  await waitFor(() =>
    expect(
      fetchMock.mock.calls.some(([url]) => String(url) === '/api/jobs/job-activity/stop'),
    ).toBe(true),
  )
})

test('the team room’s share uses the selected job thread and says what All shares', async () => {
  stubRoom([makeJob({ id: 'job-activity', title: 'Activity feed' })])
  renderInRoom(<BoldTeamRoom agents={agents} />, ['/b?job=job-activity'])

  fireEvent.click(await screen.findByRole('button', { name: 'Room menu' }))
  expect(
    await screen.findByText(
      /Shares the selected job’s thread; under All, the team room’s default thread/,
    ),
  ).toBeDefined()
  fireEvent.click(screen.getByRole('menuitem', { name: 'Share a read-only link' }))
  const dialog = await screen.findByRole('dialog')
  expect(dialog.textContent).toContain('Share Activity feed')
  expect(dialog.textContent).toContain('the job’s messages')
})

test('the room menu gives export, share and delete the prototype’s menu rows', async () => {
  stubRoom([makeJob({ id: 'job-1', title: 'Activity feed' })], { older: true })
  renderInRoom(<BoldTeamRoom agents={agents} />, ['/b?room=room-old'])

  fireEvent.click(await screen.findByRole('button', { name: 'Room menu' }))
  const menu = await screen.findByRole('menu', { name: '#activity-feed actions' })
  expect(menu.textContent).toContain('Export this room')
  expect(menu.textContent).toContain('Share a read-only link')
  expect(menu.textContent).toContain('Delete #activity-feed')
  expect(
    [...menu.querySelectorAll('[role="menuitem"]')].every((item) => item.classList.contains('mi')),
  ).toBe(true)
  expect(menu.getAttribute('data-protected')).toBe('flex')
})

test('Team lead… opens from the team room menu and Cancel gives focus back to the menu button', async () => {
  stubRoom([makeJob({ id: 'job-activity', title: 'Activity feed' })])
  renderInRoom(<BoldTeamRoom agents={agents} />, ['/b?job=job-activity'])
  const trigger = await screen.findByRole('button', { name: 'Room menu' })
  fireEvent.click(trigger)
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Team lead…' }))
  await screen.findByRole('dialog', { name: 'Team lead' })
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Team lead' })).toBeNull())
  expect(document.activeElement).toBe(trigger)
})

// 3.22.0: the job tabs and filters are gone; the chat is one conversation with a divider per topic. Each test below
// replaces one the stage-2 rewrite removed, and checks the new behaviour of the same promise.

// was: 'the room shows job tabs, the To chip and the seeded unread count'
test('the room shows one divider per topic (no tabs or filter chips) and the context bar names the current one', async () => {
  stubRoom([
    makeJob({
      id: 'job-1',
      title: 'Activity feed',
      unread: 2,
      createdAt: '2026-10-24T09:00:00.000Z',
    }),
    makeJob({
      id: 'job-2',
      title: 'Release notes',
      unread: 3,
      createdAt: '2026-10-24T09:30:00.000Z',
    }),
  ])
  renderInRoom(<BoldTeamRoom agents={agents} />, ['/b'])
  await screen.findByRole('separator', { name: 'Topic: Activity feed, working' })
  expect(screen.getByRole('separator', { name: 'Topic: Release notes, working' })).toBeDefined()
  expect(screen.queryByRole('tablist')).toBeNull()
  expect(screen.queryByRole('tab')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Needs you' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Closed jobs' })).toBeNull()
  // The newest open topic is current, so a message goes there.
  const bar = await screen.findByLabelText('Where this message goes')
  expect(bar.textContent).toContain('To')
  expect(bar.textContent).toContain('lead')
  expect(bar.textContent).toContain('in Release notes')
})

// 3.24.0: the All topics screen is gone. Was: 'a phone’s All topics list puts the pinned request first, then the general
// conversation and the topics with their unread counts'. The request now sits in the conversation.
test('a phone opens straight into the conversation, with the needs-you card inside it and no All topics screen', async () => {
  stubRoom(
    [
      makeJob({ id: 'job-default', title: 'Team room', isDefault: true, unread: 9 }),
      makeJob({ id: 'job-activity', title: 'Activity feed', unread: 2 }),
    ],
    { approvals: [phoneApproval] },
  )
  renderInRoom(<BoldTeamRoom agents={agents} phone />, ['/b?jobs=1'])

  const pin = await screen.findByRole('article', {
    name: /Needs you: May I install a package/,
  })
  expect(pin.getAttribute('data-protected')).toBe('flex')
  expect(pin.closest('.bold-stream')).not.toBeNull()
  expect(screen.queryByRole('heading', { name: 'All topics' })).toBeNull()
  expect(screen.queryByRole('region', { name: 'All topics' })).toBeNull()
  expect(await screen.findByRole('combobox', { name: /^Message Team room/ })).toBeDefined()
})

// 3.24.0: was 'a missing phone topic shows All topics with a short note, never a Back header' and '…in a fresh room
// still shows All topics, not the starter': the note stays, the conversation shows instead of a list.
test('a missing phone topic says so and shows the conversation, never a list or a Back header', async () => {
  stubRoom([makeJob({ id: 'job-activity', title: 'Activity feed' })])
  renderInRoom(<BoldTeamRoom agents={agents} phone />, ['/b?job=job-deleted'])

  expect(await screen.findByText('That job isn’t here any more.')).toBeDefined()
  expect(screen.queryByRole('heading', { name: 'All topics' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Back to jobs' })).toBeNull()
  expect(await screen.findByRole('combobox', { name: /^Message / })).toBeDefined()
})

test('a missing phone topic in a fresh room says so, with no list', async () => {
  stubRoom([])
  renderInRoom(<BoldTeamRoom agents={agents} phone />, ['/b?job=job-deleted'])

  expect(await screen.findByText('That job isn’t here any more.')).toBeDefined()
  expect(screen.queryByRole('heading', { name: 'All topics' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Back to jobs' })).toBeNull()
})

// was: 'selecting a job changes the composer destination and hides the message param'
test('one job per chat: the context bar says only who it goes to, and a message goes to the active job, else the chat’s own thread', async () => {
  stubRoom([
    makeJob({ id: 'job-default', title: 'Team room', isDefault: true }),
    makeJob({
      id: 'job-old',
      title: 'Old work',
      state: 'done',
      createdAt: '2026-10-24T08:00:00.000Z',
    }),
    makeJob({ id: 'job-1', title: 'Activity feed', createdAt: '2026-10-24T09:00:00.000Z' }),
  ])
  // A finished job opened from Past jobs is read-only: the message still goes to the chat's active job.
  const first = renderInRoom(<BoldTeamRoom agents={agents} />, ['/b?job=job-old&message=old'])
  const bar = await screen.findByLabelText('Where this message goes')
  expect(bar.textContent).toContain('lead')
  expect(bar.textContent).not.toContain(' in ')
  first.unmount()

  const second = renderInRoom(<BoldTeamRoom agents={agents} />, ['/b'])
  await screen.findByRole('region', { name: 'Current job' })
  expect(screen.getByLabelText('Where this message goes').textContent).not.toContain(' in ')
  second.unmount()

  // With every job finished, a message goes to the chat's own thread: no bar, no "in …".
  stubRoom([
    makeJob({ id: 'job-default', title: 'Team room', isDefault: true }),
    makeJob({ id: 'job-old', title: 'Old work', state: 'done' }),
  ])
  renderInRoom(<BoldTeamRoom agents={agents} />, ['/b'])
  await screen.findByLabelText('Where this message goes')
  expect(screen.queryByRole('region', { name: 'Current job' })).toBeNull()
  expect(screen.queryByRole('separator')).toBeNull()
  expect(screen.getByLabelText('Where this message goes').textContent).not.toContain(' in ')
})

test('an older chat that still holds several active jobs keeps choosing: the context bar names the newest open one', async () => {
  stubRoom([
    makeJob({ id: 'job-default', title: 'Team room', isDefault: true }),
    makeJob({ id: 'job-1', title: 'Activity feed', createdAt: '2026-10-24T09:00:00.000Z' }),
    makeJob({ id: 'job-2', title: 'Release notes', createdAt: '2026-10-24T09:30:00.000Z' }),
  ])
  renderInRoom(<BoldTeamRoom agents={agents} />, ['/b'])
  await waitFor(() =>
    expect(screen.getByLabelText('Where this message goes').textContent).toContain(
      'in Release notes',
    ),
  )
  // 3.30.0: the bar is the newest active job's, with "+N more open"; the dividers stay for the rest.
  const bar = await screen.findByRole('region', { name: 'Current job' })
  expect(within(bar).getByText('Release notes')).toBeDefined()
  expect(within(bar).getByRole('button', { name: '+1 more open' })).toBeDefined()
  expect(screen.getAllByRole('separator').length).toBeGreaterThan(1)
})

test('"+N more open" on an older chat’s bar asks for Info’s Open jobs', async () => {
  stubRoom([
    makeJob({ id: 'job-default', title: 'Team room', isDefault: true }),
    makeJob({ id: 'job-1', title: 'Activity feed', createdAt: '2026-10-24T09:00:00.000Z' }),
    makeJob({ id: 'job-2', title: 'Release notes', createdAt: '2026-10-24T09:30:00.000Z' }),
    makeJob({ id: 'job-3', title: 'Docs', createdAt: '2026-10-24T09:40:00.000Z' }),
  ])
  renderInRoom(
    <>
      <BoldTeamRoom agents={agents} />
      <ParamsProbe />
    </>,
    ['/b'],
  )
  const bar = await screen.findByRole('region', { name: 'Current job' })
  expect(within(bar).getByText('Docs')).toBeDefined()
  fireEvent.click(within(bar).getByRole('button', { name: '+2 more open' }))
  await waitFor(() => expect(screen.getByTestId('params').textContent).toContain('jobs=open'))
})

test('a job waiting on you says so in its bar with a protected Needs you pill', async () => {
  stubRoom([
    makeJob({ id: 'job-default', title: 'Team room', isDefault: true }),
    makeJob({ id: 'job-1', title: 'Activity feed', state: 'waiting_on_you' }),
  ])
  renderInRoom(<BoldTeamRoom agents={agents} />, ['/b'])
  const bar = await screen.findByRole('region', { name: 'Current job' })
  const pill = within(bar).getByRole('button', { name: /needs you/i })
  expect(pill.getAttribute('data-protected')).toBe('inline-flex')
  expect(pill.textContent).toBe('Needs you')
  // Tapping with no card in view does nothing and breaks nothing.
  fireEvent.click(pill)
  expect(screen.getByRole('region', { name: 'Current job' })).toBeDefined()
  cleanup()
  stubRoom([
    makeJob({ id: 'job-default', title: 'Team room', isDefault: true }),
    makeJob({ id: 'job-1', title: 'Activity feed', state: 'working' }),
  ])
  renderInRoom(<BoldTeamRoom agents={agents} />, ['/b'])
  const working = await screen.findByRole('region', { name: 'Current job' })
  expect(within(working).queryByText('Needs you')).toBeNull()
})

test('the job bar shows only with an active job, with its title, state line and Stop job', async () => {
  stubRoom([
    makeJob({ id: 'job-default', title: 'Team room', isDefault: true }),
    makeJob({
      id: 'job-1',
      title: 'Activity feed',
      holderAgentId: 'builder',
      activeAgents: ['builder'],
      spendCapUsd: 5,
    }),
  ])
  renderInRoom(<BoldTeamRoom agents={agents} />, ['/b'])
  const bar = await screen.findByRole('region', { name: 'Current job' })
  expect(bar.getAttribute('data-protected')).toBe('block')
  expect(bar.textContent).toContain('JOB')
  expect(within(bar).getByText('Activity feed').getAttribute('title')).toBe('Activity feed')
  expect(bar.textContent).toContain('builder is working')
  expect(bar.textContent).toContain('cap $5.00')
  expect(within(bar).getByRole('button', { name: 'Stop job' })).toBeDefined()
  // No run, no Graph.
  expect(within(bar).queryByRole('button', { name: 'Graph' })).toBeNull()
  // One job: no divider in the stream.
  expect(screen.queryByRole('separator')).toBeNull()
})

test('a job with a run shows Graph on the bar, which opens the side panel’s Graph tab for it', async () => {
  stubRoom([
    makeJob({
      id: 'job-1',
      title: 'Activity feed',
      recipe: { kind: 'orchestration', ref: 'orch-1' },
    }),
  ])
  const shown: string[] = []
  renderInRoom(<BoldTeamRoom agents={agents} onShowGraph={(id) => shown.push(id)} />, ['/b'])
  const bar = await screen.findByRole('region', { name: 'Current job' })
  fireEvent.click(within(bar).getByRole('button', { name: 'Graph' }))
  expect(shown).toEqual(['job-1'])
})

test('Stop job on the bar asks first, then ends the job; Keep going leaves it running', async () => {
  const fetchMock = stubRoom([makeJob({ id: 'job-1', title: 'Activity feed' })])
  const fallback = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation(async (input, init) => {
    if (String(input) === '/api/jobs/job-1/end' && init?.method === 'POST')
      return jsonResponse(makeJob({ id: 'job-1', title: 'Activity feed', state: 'closed' }))
    return fallback(input, init)
  })
  renderInRoom(<BoldTeamRoom agents={agents} />, ['/b'])
  const bar = await screen.findByRole('region', { name: 'Current job' })
  fireEvent.click(within(bar).getByRole('button', { name: 'Stop job' }))
  const confirm = screen.getByRole('alertdialog', { name: 'Stop Activity feed?' })
  expect(confirm.getAttribute('data-protected')).toBe('block')
  expect(confirm.textContent).toContain('Stop “Activity feed”?')
  expect(confirm.textContent).toContain(
    'Running steps stop and the job closes. What it made stays in Past jobs.',
  )
  // Keep going closes the confirm and sends nothing.
  fireEvent.click(within(confirm).getByRole('button', { name: 'Keep going' }))
  expect(screen.queryByRole('alertdialog')).toBeNull()
  expect(lastRequest(fetchMock, '/api/jobs/job-1/end', 'POST')).toBeUndefined()

  fireEvent.click(within(bar).getByRole('button', { name: 'Stop job' }))
  fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Stop job' }))
  await waitFor(() => expect(lastRequest(fetchMock, '/api/jobs/job-1/end', 'POST')).toBeDefined())
  // The job is closed: its bar goes, and the result stays where it was.
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Current job' })).toBeNull())
  const note = await screen.findByText('Stopped “Activity feed”. It’s in Past jobs.')
  expect(note.getAttribute('role')).toBe('status')
})

test('Next up shows a queued trigger call under the bar, and Skip drops it', async () => {
  const queue = {
    asOfSeq: 1,
    items: [
      {
        id: 'q-1',
        roomId: 'room-1',
        title: 'Nightly report',
        source: { app: 'schedule', ref: 'nightly', title: null, triggerId: 'trg-1' },
        createdAt: '2026-10-24T09:10:00.000Z',
      },
    ],
  }
  let skipped = false
  const fetchMock = stubRoom([makeJob({ id: 'job-1', title: 'Activity feed' })])
  const fallback = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input)
    if (url === '/api/rooms/room-1/queue/q-1' && init?.method === 'DELETE') {
      skipped = true
      return new Response(null, { status: 204 })
    }
    if (url === '/api/rooms/room-1/queue')
      return jsonResponse(skipped ? { asOfSeq: 2, items: [] } : queue)
    return fallback(input, init)
  })
  renderInRoom(<BoldTeamRoom agents={agents} />, ['/b'])
  const next = await screen.findByRole('region', { name: 'Next up' })
  expect(next.getAttribute('data-protected')).toBe('block')
  expect(next.textContent).toContain('Next up:')
  expect(next.textContent).toContain('“Nightly report” from schedule waits until this job ends.')
  fireEvent.click(within(next).getByRole('button', { name: /^Skip/ }))
  await waitFor(() => expect(skipped).toBe(true))
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Next up' })).toBeNull())
})

// was: 'opening the room reads only the jobs on screen, and a second job waits for its tab'
test('opening the room reads the whole chat in one chain, not one read per topic', async () => {
  const fetchMock = stubRoom([
    makeJob({ id: 'job-default', title: 'Team room', isDefault: true }),
    makeJob({ id: 'job-activity', title: 'Activity feed', unread: 4 }),
    makeJob({ id: 'job-notes', title: 'Release notes', unread: 1 }),
  ])
  renderInRoom(<BoldTeamRoom agents={agents} />, ['/b'])
  await screen.findByRole('separator', { name: 'Topic: Activity feed, working' })
  const reads = () =>
    fetchMock.mock.calls
      .map(([url]) => String(url))
      .filter((url) => url.startsWith('/api/rooms/room-1/messages?'))
  await waitFor(() => expect(reads().some((url) => url.includes('all=1'))).toBe(true))
  expect(reads().every((url) => url.includes('all=1'))).toBe(true)
  expect(reads().some((url) => url.includes('jobId='))).toBe(false)
})

// 3.24.0: the chat header has Chat info and no "+ Job"; Start a run lives in the composer's + menu.
test('the team room header has no + Job button; the composer’s + menu offers Start a run', async () => {
  stubRoom([makeJob({ id: 'job-1', title: 'Activity feed' })])
  renderInRoom(<BoldTeamRoom agents={agents} />, ['/b'])

  await screen.findByRole('combobox', { name: /^Message Team room/ })
  expect(screen.queryByRole('button', { name: 'Start a job' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Attach, voice and commands' }))
  expect(await screen.findByRole('button', { name: 'Start a run…' })).toBeDefined()
})

// was: 'the room dropdown opens an older room read-write with today’s @mention routing'
test('an older room opens read-write with today’s @mention routing', async () => {
  const fetchMock = stubRoom([makeJob({ id: 'job-1', title: 'Activity feed' })], { older: true })
  renderInRoom(<BoldTeamRoom agents={agents} />, ['/b?room=room-old'])

  expect(await screen.findByText('Older room')).toBeDefined()
  expect(screen.queryByRole('button', { name: 'Start a job' })).toBeNull()
  const composer = await screen.findByRole('combobox', { name: /^Message #activity-feed/ })
  fireEvent.change(composer, { target: { value: '@builder Where is the feed?' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))

  await waitFor(() => {
    const sent = lastRequest(fetchMock, '/api/rooms/room-old/messages', 'POST')
    expect(sent).toBeDefined()
    expect(JSON.parse(String(sent?.[1]?.body))).toMatchObject({
      text: '@builder Where is the feed?',
    })
  })
})

// was: 'rename sends PATCH with the trimmed title'
test('renaming the job from its bar menu sends PATCH with the trimmed title and relabels the bar', async () => {
  const fetchMock = stubRoom([makeJob({ id: 'job-activity', title: 'Activity feed' })])
  const fallback = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation(async (input, init) => {
    if (String(input) === '/api/jobs/job-activity' && init?.method === 'PATCH')
      return jsonResponse(makeJob({ id: 'job-activity', title: 'Activity feed v2' }))
    return fallback(input, init)
  })
  renderInRoom(<BoldTeamRoom agents={agents} />, ['/b?job=job-activity'])
  await screen.findByRole('region', { name: 'Current job' })
  fireEvent.click(within(jobBar()).getByRole('button', { name: 'Job menu' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename…' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), {
    target: { value: '  Activity feed v2  ' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
  await waitFor(() =>
    expect(lastRequest(fetchMock, '/api/jobs/job-activity', 'PATCH')).toBeDefined(),
  )
  expect(
    JSON.parse(String(lastRequest(fetchMock, '/api/jobs/job-activity', 'PATCH')![1]!.body)),
  ).toEqual({
    title: 'Activity feed v2',
  })
  expect(await screen.findByText('Renamed “Activity feed v2”.')).toBeDefined()
  expect(within(jobBar()).getByText('Activity feed v2')).toBeDefined()
  expect(within(jobBar()).queryByText('Activity feed')).toBeNull()
})

// was: 'delete asks for the typed title, then offers a 10-second undo that restores'
test('deleting the job asks for its typed title, takes its bar away, and Undo brings it back', async () => {
  const fetchMock = stubRoom([makeJob({ id: 'job-activity', title: 'Activity feed' })])
  const fallback = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input)
    if (url === '/api/jobs/job-activity' && init?.method === 'DELETE')
      return new Response(null, { status: 204 })
    if (url === '/api/jobs/job-activity/restore' && init?.method === 'POST')
      return jsonResponse(makeJob({ id: 'job-activity', title: 'Activity feed' }))
    return fallback(input, init)
  })
  renderInRoom(
    <>
      <BoldTeamRoom agents={agents} />
      <JobUndoToast />
    </>,
    ['/b?job=job-activity'],
  )
  await screen.findByRole('region', { name: 'Current job' })
  fireEvent.click(within(jobBar()).getByRole('button', { name: 'Job menu' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete job' }))
  const confirm = screen.getByRole('button', { name: 'Delete job' })
  expect((confirm as HTMLButtonElement).disabled).toBe(true)
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Activity feed' } })
  expect((confirm as HTMLButtonElement).disabled).toBe(false)
  fireEvent.click(confirm)
  expect(await screen.findByText(/Job deleted/)).toBeDefined()
  expect(screen.queryByRole('region', { name: 'Current job' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
  await waitFor(() =>
    expect(lastRequest(fetchMock, '/api/jobs/job-activity/restore', 'POST')).toBeDefined(),
  )
  expect(await screen.findByText('Restored “Activity feed”.')).toBeDefined()
  expect(
    within(await screen.findByRole('region', { name: 'Current job' })).getByText('Activity feed'),
  ).toBeDefined()
})

// was: 'closing a job posts close and tells the person where to find it'
test('closing the job posts close, says how to reopen it, and it reads as a past job', async () => {
  const fetchMock = stubRoom([makeJob({ id: 'job-activity', title: 'Activity feed' })])
  const fallback = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation(async (input, init) => {
    if (String(input) === '/api/jobs/job-activity/close' && init?.method === 'POST')
      return jsonResponse(makeJob({ id: 'job-activity', state: 'closed' }))
    return fallback(input, init)
  })
  renderInRoom(<BoldTeamRoom agents={agents} />, ['/b?job=job-activity'])
  await screen.findByRole('region', { name: 'Current job' })

  fireEvent.click(within(jobBar()).getByRole('button', { name: 'Job menu' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Close' }))

  expect(await screen.findByText('Closed “Activity feed”. Reopen it from its menu.')).toBeDefined()
  // It stays reachable as a closed past job: nothing disappears into a hidden list.
  const past = await screen.findByRole('region', { name: 'Past job' })
  expect(past.textContent).toContain('Activity feed')
  expect(past.textContent).toContain('Closed')
  expect(screen.queryByRole('region', { name: 'Current job' })).toBeNull()
  const call = lastRequest(fetchMock, '/api/jobs/job-activity/close', 'POST')
  expect(call).toBeDefined()
  expect(new Headers(call?.[1]?.headers).get('Idempotency-Key')).toBeTruthy()
})

// was: 'a closed job is listed under Closed jobs and its menu reopens it'
test('a past job opened from Info shows its own bar, and its menu reopens it', async () => {
  const fetchMock = stubRoom([makeJob({ id: 'job-closed', title: 'Old import', state: 'closed' })])
  const fallback = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation(async (input, init) => {
    if (String(input) === '/api/jobs/job-closed/reopen' && init?.method === 'POST')
      return jsonResponse(makeJob({ id: 'job-closed', title: 'Old import', state: 'open' }))
    return fallback(input, init)
  })
  renderInRoom(<BoldTeamRoom agents={agents} />, ['/b?job=job-closed'])

  const past = await screen.findByRole('region', { name: 'Past job' })
  expect(past.textContent).toContain('Old import')
  expect(past.textContent).toContain('opened read-only')
  expect(within(past).queryByRole('button', { name: 'Stop job' })).toBeNull()
  fireEvent.click(within(past).getByRole('button', { name: 'Job menu' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Reopen' }))

  expect(await screen.findByText('Reopened “Old import”.')).toBeDefined()
  // Reopened, it is the chat's one active job: the Current job bar replaces the past one.
  expect(
    within(await screen.findByRole('region', { name: 'Current job' })).getByText('Old import'),
  ).toBeDefined()
  expect(lastRequest(fetchMock, '/api/jobs/job-closed/reopen', 'POST')).toBeDefined()
  expect(screen.getByLabelText('Where this message goes').textContent).not.toContain(' in ')
})

// was: 'a closed job from the server snapshot is under Closed jobs after a reload'
test('a job closed in the server snapshot is a past job beside the running one: the running job keeps its bar', async () => {
  const closed = makeJob({ id: 'job-closed', title: 'Old import', state: 'closed' })
  stubRoom([closed, makeJob({ id: 'job-activity', title: 'Activity feed' })])
  renderInRoom(<BoldTeamRoom agents={agents} />, ['/b?job=job-closed'])

  const past = await screen.findByRole('region', { name: 'Past job' })
  expect(past.textContent).toContain('Closed')
  expect(
    within(await screen.findByRole('region', { name: 'Current job' })).getByText('Activity feed'),
  ).toBeDefined()
  expect(screen.queryByRole('separator')).toBeNull()
  expect(within(past).getByRole('button', { name: 'Job menu' })).toBeDefined()
})

// was: 'a job.deleted event returns the open job to All with a note'
test('a job.deleted event takes the open job out of the conversation, clears ?job= and says why', async () => {
  stubRoom([
    makeJob({ id: 'job-activity', title: 'Activity feed' }),
    makeJob({ id: 'job-notes', title: 'Release notes' }),
  ])
  const view = renderInRoom(
    <>
      <BoldTeamRoom agents={agents} />
      <ParamsProbe />
    </>,
    ['/b?job=job-activity'],
  )
  await screen.findByRole('separator', { name: 'Topic: Activity feed, working' })

  view.emit({
    seq: 2,
    ts: '2026-10-24T10:00:00.000Z',
    type: 'job.deleted',
    data: { id: 'job-activity', roomId: room.id },
  })

  expect(await screen.findByText('That job was deleted.')).toBeDefined()
  await waitFor(() => expect(screen.getByTestId('params').textContent).not.toContain('job='))
  expect(screen.queryByRole('separator', { name: /^Topic: Activity feed/ })).toBeNull()
  // One job is left, so the chat drops its dividers and shows Release notes on the bar.
  expect(screen.queryByRole('separator')).toBeNull()
  expect(
    within(await screen.findByRole('region', { name: 'Current job' })).getByText('Release notes'),
  ).toBeDefined()
})

// was: 'a job.deleted event returns an open phone job to the list with a note'
test('a job.deleted event returns an open phone topic to the chat with a note', async () => {
  stubRoom([
    makeJob({ id: 'job-activity', title: 'Activity feed' }),
    makeJob({ id: 'job-notes', title: 'Release notes' }),
  ])
  const view = renderInRoom(
    <>
      <BoldTeamRoom agents={agents} phone />
      <ParamsProbe />
    </>,
    ['/b?job=job-activity'],
  )
  await screen.findByRole('button', { name: 'Back to chats' })

  view.emit({
    seq: 2,
    ts: '2026-10-24T10:00:00.000Z',
    type: 'job.deleted',
    data: { id: 'job-activity', roomId: room.id },
  })

  expect(await screen.findByText('That job was deleted.')).toBeDefined()
  await waitFor(() => expect(screen.getByTestId('params').textContent).not.toContain('job='))
  expect(screen.getByRole('button', { name: 'Back to chats' })).toBeDefined()
})

// was: 'a room whose messages were all deleted offers the real toggle on the starter board'
test('a room whose messages were all deleted offers Show deleted messages in the room ⋯ menu, which hides the starter board', async () => {
  stubRoom([], {
    versions: [
      {
        id: 'v1',
        roomId: 'room-1',
        anchorId: 'm1',
        anchorCreatedAt: '2026-10-24T10:00:00.000Z',
        mode: 'delete',
        replacedBy: null,
        number: 1,
        count: 1,
        hiddenCount: 1,
        rewound: [],
        skipped: [],
        createdAt: '2026-10-24T10:01:00.000Z',
      },
    ],
  })
  renderInRoom(<BoldTeamRoom agents={agents} />, ['/b'])
  // Nothing sits above the conversation: the toggle is not a link on the board any more.
  await screen.findByRole('heading', { name: 'Your team is ready. What first?' })
  expect(screen.queryByRole('button', { name: 'Show deleted messages' })).toBeNull()

  fireEvent.click(await screen.findByRole('button', { name: 'Room menu' }))
  const show = await screen.findByRole('menuitemcheckbox', { name: 'Show deleted messages' })
  expect(show.getAttribute('aria-checked')).toBe('false')
  fireEvent.click(show)
  await waitFor(() =>
    expect(screen.queryByRole('heading', { name: 'Your team is ready. What first?' })).toBeNull(),
  )

  fireEvent.click(await screen.findByRole('button', { name: 'Room menu' }))
  const hide = await screen.findByRole('menuitemcheckbox', { name: 'Hide deleted messages' })
  expect(hide.getAttribute('aria-checked')).toBe('true')
  fireEvent.click(hide)
  expect(
    await screen.findByRole('heading', { name: 'Your team is ready. What first?' }),
  ).toBeDefined()
})

// 3.22.0: the / palette in the chat's composer.
test('typing / opens the palette above the composer: it filters as you type, arrows and Enter pick, Esc closes', async () => {
  stubRoom([makeJob({ id: 'job-1', title: 'Activity feed' })])
  renderInRoom(<BoldTeamRoom agents={agents} />, ['/b'])
  const composer = (await screen.findByRole('combobox', {
    name: /^Message Team room/,
  })) as HTMLTextAreaElement

  fireEvent.change(composer, { target: { value: '/' } })
  const palette = await screen.findByRole('listbox', { name: 'Commands' })
  const names = () =>
    within(palette)
      .getAllByRole('option')
      .map((option) => option.querySelector('.chat-menu-command')?.textContent)
  for (const name of ['/rename', '/done', '/reopen', '/lead', '/add', '/remove', '/workspace'])
    expect(names()).toContain(name)
  // A chat does one job at a time: /new is not offered.
  expect(names()).not.toContain('/new')
  // Each entry carries its one-line description.
  expect(within(palette).getByRole('option', { name: /\/done/ }).textContent).toContain(
    'Close the current job',
  )

  fireEvent.change(composer, { target: { value: '/re' } })
  await waitFor(() =>
    expect(names()).toEqual(expect.arrayContaining(['/rename', '/reopen', '/remove'])),
  )
  expect(names()).not.toContain('/new')

  fireEvent.keyDown(composer, { key: 'ArrowDown' })
  fireEvent.keyDown(composer, { key: 'Enter' })
  await waitFor(() => expect(composer.value).toMatch(/^\/(reopen|remove) ?$/))
  expect(composer.value).not.toBe('/rename ')

  fireEvent.change(composer, { target: { value: '/' } })
  await screen.findByRole('listbox', { name: 'Commands' })
  fireEvent.keyDown(composer, { key: 'Escape' })
  await waitFor(() => expect(screen.queryByRole('listbox', { name: 'Commands' })).toBeNull())
})

test('an unknown /command gets a plain-words hint and nothing is sent', async () => {
  const fetchMock = stubRoom([makeJob({ id: 'job-1', title: 'Activity feed' })])
  renderInRoom(<BoldTeamRoom agents={agents} />, ['/b'])
  const composer = await screen.findByRole('combobox', { name: /^Message Team room/ })
  fireEvent.change(composer, { target: { value: '/frobnicate now' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  expect(
    await screen.findByText('I don’t know /frobnicate. Type / to see the commands.'),
  ).toBeDefined()
  expect(
    fetchMock.mock.calls.some(
      ([url, init]) => String(url).includes('/messages') && init?.method === 'POST',
    ),
  ).toBe(false)
  expect((composer as HTMLTextAreaElement).value).toBe('/frobnicate now')
})

test('/new is refused with the one-job words: nothing is created or sent, and the text stays', async () => {
  const fetchMock = stubRoom([makeJob({ id: 'job-1', title: 'Activity feed' })])
  renderInRoom(<BoldTeamRoom agents={agents} />, ['/b'])
  const composer = (await screen.findByRole('combobox', {
    name: /^Message Team room/,
  })) as HTMLTextAreaElement
  fireEvent.change(composer, { target: { value: '/new Fix login' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  expect(
    await screen.findByText(
      'A chat does one job at a time: start one with /run, or Stop the current job first.',
    ),
  ).toBeDefined()
  expect(composer.value).toBe('/new Fix login')
  expect(lastRequest(fetchMock, '/api/rooms/room-1/jobs', 'POST')).toBeUndefined()
  expect(
    fetchMock.mock.calls.some(
      ([url, init]) => String(url).endsWith('/messages') && init?.method === 'POST',
    ),
  ).toBe(false)
})

test('a failing chat command shows its reason under the composer and keeps what was typed', async () => {
  stubRoom([makeJob({ id: 'job-1', title: 'Activity feed' })])
  renderInRoom(<BoldTeamRoom agents={agents} />, ['/b'])
  const composer = (await screen.findByRole('combobox', {
    name: /^Message Team room/,
  })) as HTMLTextAreaElement
  fireEvent.change(composer, { target: { value: '/add @nobody' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  expect(await screen.findByText(/There is no agent called @nobody/)).toBeDefined()
  expect(composer.value).toBe('/add @nobody')
})

test('with ?job= set and the topics still loading, the composer is held rather than posting to the general conversation', async () => {
  const inner = stubRoom([], { older: true })
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
    String(input).includes('/api/rooms/room-old/jobs')
      ? gate.then(() => inner(input, init))
      : inner(input, init),
  )
  renderInRoom(<BoldTeamRoom agents={agents} />, ['/b?room=room-old&job=job-old'])
  const held = (await screen.findByRole(
    'combobox',
    { name: /^Message #activity-feed/ },
    { timeout: 4000 },
  )) as HTMLTextAreaElement
  expect(held.disabled).toBe(true)
  expect(held.placeholder).toBe('Loading the job…')
  release()
  await waitFor(() => expect(held.disabled).toBe(false), { timeout: 4000 })
})

// Replaces 'moving to another topic drops its file and keeps the other parameters' (the phone list it used is gone):
// the lifecycle path (Reopen moving to another topic) goes through the same selectJob.
test('reopening another job drops the open file but keeps the other parameters', async () => {
  const closed = makeJob({ id: 'job-closed', title: 'Old import', state: 'closed' })
  // An older chat that still holds two active jobs keeps its dividers, so another job's menu is on screen.
  const fetchMock = stubRoom([
    closed,
    makeJob({ id: 'job-activity', title: 'Activity feed' }),
    makeJob({ id: 'job-notes', title: 'Release notes' }),
  ])
  const fallback = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation(async (input, init) => {
    if (String(input) === '/api/jobs/job-closed/reopen' && init?.method === 'POST')
      return jsonResponse({ ...closed, state: 'open' })
    return fallback(input, init)
  })
  renderInRoom(
    <>
      <BoldTeamRoom agents={agents} />
      <ParamsProbe />
    </>,
    ['/b?job=job-activity&file=notes.md&keep=1'],
  )
  await screen.findByRole('separator', { name: 'Topic: Old import, closed' })
  expect(screen.getByTestId('params').textContent).toContain('file=notes.md')
  fireEvent.click(within(topicDivider('Old import')).getByRole('button', { name: 'Job menu' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Reopen' }))
  await waitFor(() => expect(screen.getByTestId('params').textContent).toContain('job=job-closed'))
  const params = new URLSearchParams(screen.getByTestId('params').textContent ?? '')
  expect(params.has('file')).toBe(false)
  expect(params.get('keep')).toBe('1')
})

test('a ?message= seek is cleared from the address once the message is found', async () => {
  const fetchMock = stubRoom([makeJob({ id: 'job-activity', title: 'Activity feed' })])
  const fallback = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation(async (input, init) => {
    const parsed = new URL(String(input), 'http://x')
    if (parsed.pathname === '/api/rooms/room-1/messages' && (init?.method ?? 'GET') === 'GET')
      return jsonResponse({
        asOfSeq: 1,
        items: [
          makeMessage({
            id: 'message-seek',
            jobId: 'job-activity',
            parts: [{ kind: 'text', text: 'Find me.' }],
          }),
        ],
        nextCursor: null,
        jobId: parsed.searchParams.get('jobId'),
      })
    return fallback(input, init)
  })
  renderInRoom(
    <>
      <BoldTeamRoom agents={agents} />
      <ParamsProbe />
    </>,
    ['/b?job=job-activity&message=message-seek'],
  )
  expect(await screen.findByText('Find me.')).toBeDefined()
  await waitFor(() => expect(screen.getByTestId('params').textContent).not.toContain('message='))
  expect(screen.getByTestId('params').textContent).toContain('job=job-activity')
})

test('on a phone, opening a chat moves focus to the chat title', async () => {
  stubRoom([makeJob({ id: 'job-1', title: 'Activity feed' })], { older: true })
  renderInRoom(<BoldTeamRoom agents={agents} phone onBackToChats={() => undefined} />, [
    '/b?room=room-old',
  ])
  await screen.findByRole('button', { name: 'Back to chats' })
  await waitFor(() => {
    const title = document.querySelector('[data-phone-chat-title]')
    expect(title).not.toBeNull()
    expect(document.activeElement).toBe(title)
  })
})

// 3.28.0: starting work while the chat has a job asks first (the busy dialog), whichever way it was started.
function renderBusy(jobsList = [makeJob({ id: 'job-1', title: 'Story suite prompts' })]) {
  const opened: (StartJobOptions | undefined)[] = []
  const fetchMock = stubRoom(jobsList)
  const fallback = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation(async (input, init) => {
    if (String(input) === '/api/jobs/job-1/end' && init?.method === 'POST')
      return jsonResponse(makeJob({ id: 'job-1', title: 'Story suite prompts', state: 'closed' }))
    return fallback(input, init)
  })
  renderInRoom(
    <StartJobContext value={{ openStartJob: (options) => opened.push(options) }}>
      <BoldTeamRoom agents={agents} />
    </StartJobContext>,
    ['/b'],
  )
  return { opened, fetchMock }
}

async function startRunFromMenu() {
  await screen.findByRole('region', { name: 'Current job' })
  fireEvent.click(await screen.findByRole('button', { name: 'Attach, voice and commands' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Start a run…' }))
  return screen.findByRole('dialog', { name: 'Team room already has a job' })
}

test('the + menu’s Start a run… with a job running opens the busy dialog instead of Start a job', async () => {
  const { opened } = renderBusy()
  const dialog = await startRunFromMenu()
  expect(dialog.getAttribute('data-protected')).toBe('block')
  expect(dialog.textContent).toContain('“Story suite prompts” is still running.')
  expect(dialog.textContent).toContain('New: a new run')
  expect(opened).toEqual([])
  // Cancel is where focus starts; Escape cancels and focus goes back to a sensible place (the composer).
  expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }))
  fireEvent.keyDown(dialog, { key: 'Escape' })
  await waitFor(() =>
    expect(screen.queryByRole('dialog', { name: 'Team room already has a job' })).toBeNull(),
  )
  expect(opened).toEqual([])
  expect(document.activeElement).toBe(screen.getByRole('combobox', { name: /^Message Team room/ }))
})

test('the busy dialog keeps Tab inside it', async () => {
  renderBusy()
  const dialog = await startRunFromMenu()
  const buttons = within(dialog).getAllByRole('button')
  expect(buttons.map((button) => button.textContent)).toEqual([
    'Stop the job and start this',
    'Start in another chat…',
    'Cancel',
  ])
  buttons[2]!.focus()
  fireEvent.keyDown(buttons[2]!, { key: 'Tab' })
  expect(document.activeElement).toBe(buttons[0])
  fireEvent.keyDown(buttons[0]!, { key: 'Tab', shiftKey: true })
  expect(document.activeElement).toBe(buttons[2])
})

test('/run with a job running asks first too, naming the recipe; Stop the job and start this ends it and then opens Start a job', async () => {
  const { opened, fetchMock } = renderBusy()
  await screen.findByRole('region', { name: 'Current job' })
  const composer = await screen.findByRole('combobox', { name: /^Message Team room/ })
  fireEvent.change(composer, { target: { value: '/run Write and review' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  const dialog = await screen.findByRole('dialog', { name: 'Team room already has a job' })
  expect(dialog.textContent).toContain('New: run “Write and review”')
  fireEvent.click(within(dialog).getByRole('button', { name: 'Stop the job and start this' }))
  await waitFor(() => expect(lastRequest(fetchMock, '/api/jobs/job-1/end', 'POST')).toBeDefined())
  await waitFor(() =>
    expect(opened).toEqual([{ roomId: 'room-1', recipeName: 'Write and review' }]),
  )
  expect(screen.queryByRole('dialog', { name: 'Team room already has a job' })).toBeNull()
  // The job ended, so its bar is gone.
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Current job' })).toBeNull())
})

test('Start in another chat… opens Start a job with the chat picker and without the busy chat', async () => {
  const { opened } = renderBusy()
  const dialog = await startRunFromMenu()
  fireEvent.click(within(dialog).getByRole('button', { name: 'Start in another chat…' }))
  expect(opened).toEqual([{ pickChat: true, exceptRoomId: 'room-1' }])
  expect(screen.queryByRole('dialog', { name: 'Team room already has a job' })).toBeNull()
})

test('with no job running, Start a run… goes straight to Start a job', async () => {
  const opened: (StartJobOptions | undefined)[] = []
  stubRoom([makeJob({ id: 'job-1', title: 'Old', state: 'closed' })])
  renderInRoom(
    <StartJobContext value={{ openStartJob: (options) => opened.push(options) }}>
      <BoldTeamRoom agents={agents} />
    </StartJobContext>,
    ['/b'],
  )
  fireEvent.click(await screen.findByRole('button', { name: 'Attach, voice and commands' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Start a run…' }))
  await waitFor(() => expect(opened).toEqual([{ roomId: 'room-1' }]))
  expect(screen.queryByRole('dialog', { name: 'Team room already has a job' })).toBeNull()
})
