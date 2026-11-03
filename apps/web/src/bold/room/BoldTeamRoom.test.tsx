import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { useNavigate, useSearchParams } from 'react-router'
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

function HistoryBack() {
  const navigate = useNavigate()
  return (
    <button type="button" onClick={() => void navigate(-1)}>
      History back
    </button>
  )
}

/** The divider that opens a topic, found by the title it carries. */
function topicDivider(title: string) {
  const found = screen
    .getAllByRole('separator')
    .find((item) => item.getAttribute('aria-label')?.startsWith(`Topic: ${title},`))
  if (!found) throw new Error(`No divider for the topic ${title}`)
  return found
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

// was: 'a phone opens on board 18 with the pinned request first, then jobs and their unread counts'
test('a phone’s All topics list puts the pinned request first, then the general conversation and the topics with their unread counts', async () => {
  stubRoom(
    [
      makeJob({ id: 'job-default', title: 'Team room', isDefault: true, unread: 9 }),
      makeJob({ id: 'job-activity', title: 'Activity feed', unread: 2 }),
      makeJob({ id: 'job-queue', title: 'Queue research', state: 'done', unread: 0 }),
      makeJob({
        id: 'job-notes',
        title: 'Release notes 2.4',
        state: 'waiting_on_you',
        holderAgentId: 'lead',
        unread: 3,
      }),
    ],
    { approvals: [phoneApproval] },
  )
  renderInRoom(<BoldTeamRoom agents={agents} phone />, ['/b?jobs=1'])

  expect(await screen.findByRole('heading', { name: 'All topics' })).toBeDefined()
  const general = screen.getByRole('button', { name: /^General conversation\..*9 unread/ })
  expect(general.textContent).toContain('builder is working')
  const activity = screen.getByRole('button', { name: /^Activity feed\..*2 unread/ })
  const notes = screen.getByRole('button', { name: /^Release notes 2\.4\..*3 unread/ })
  expect(activity.compareDocumentPosition(notes) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(general.compareDocumentPosition(activity) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(activity.textContent).toContain('builder is working')
  expect(notes.textContent).toContain('lead needs you')
  expect(screen.getByRole('img', { name: 'Done' })).toBeDefined()

  const pin = await screen.findByRole('article', {
    name: /Needs you: May I install a package/,
  })
  expect(pin.getAttribute('data-protected')).toBe('flex')
  const topics = screen.getByRole('region', { name: 'All topics' })
  expect(pin.compareDocumentPosition(topics) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
})

// was: 'a phone opens a job full screen and Back returns to the job list'
test('a phone opens a topic from All topics and the browser’s Back returns to the list on the row it left', async () => {
  stubRoom([
    makeJob({ id: 'job-activity', title: 'Activity feed', unread: 2 }),
    makeJob({ id: 'job-notes', title: 'Release notes 2.4' }),
  ])
  renderInRoom(
    <>
      <BoldTeamRoom agents={agents} phone />
      <ParamsProbe />
      <HistoryBack />
    </>,
    ['/b?jobs=1&message=old'],
  )

  fireEvent.click(await screen.findByRole('button', { name: /^Activity feed\./ }))
  await screen.findByRole('separator', { name: 'Topic: Activity feed, working' })
  await waitFor(() =>
    expect(document.querySelector('[data-phone-chat-title]')).toBe(document.activeElement),
  )
  expect(screen.getByTestId('params').textContent).toContain('job=job-activity')
  expect(screen.getByTestId('params').textContent).not.toContain('message')
  expect(screen.queryByRole('heading', { name: 'All topics' })).toBeNull()
  expect(
    screen.getByText(/^Activity feed · /, { selector: '.bold-chat-phone-id span' }),
  ).toBeDefined()
  expect((await screen.findByLabelText('Where this message goes')).textContent).toContain(
    'in Activity feed',
  )

  fireEvent.click(screen.getByRole('button', { name: 'History back' }))
  expect(await screen.findByRole('heading', { name: 'All topics' })).toBeDefined()
  expect(screen.getByTestId('params').textContent).not.toContain('job=')
  await waitFor(() =>
    expect(screen.getByRole('button', { name: /^Activity feed\./ })).toBe(document.activeElement),
  )
})

// was: 'moving to another job drops its file and keeps the other parameters'
test('moving to another topic drops its file and keeps the other parameters', async () => {
  stubRoom([
    makeJob({ id: 'job-activity', title: 'Activity feed' }),
    makeJob({ id: 'job-notes', title: 'Release notes 2.4' }),
  ])
  renderInRoom(
    <>
      <BoldTeamRoom agents={agents} phone />
      <ParamsProbe />
    </>,
    ['/b?jobs=1&job=job-activity&file=api%2Fevents.py&work=code'],
  )
  fireEvent.click(await screen.findByRole('button', { name: /^Release notes 2\.4\./ }))
  await waitFor(() => expect(screen.getByTestId('params').textContent).toContain('job=job-notes'))
  expect(screen.getByTestId('params').textContent).toContain('work=code')
  expect(screen.getByTestId('params').textContent).not.toContain('file=')
})

// was: 'the phone list puts the default Team room row first and opens its chat'
test('the phone list puts the general conversation first and opens it', async () => {
  stubRoom([
    makeJob({ id: 'job-default', title: 'Team room', isDefault: true, unread: 4 }),
    makeJob({ id: 'job-activity', title: 'Activity feed', unread: 2 }),
  ])
  renderInRoom(
    <>
      <BoldTeamRoom agents={agents} phone />
      <ParamsProbe />
    </>,
    ['/b?jobs=1'],
  )

  const general = await screen.findByRole('button', { name: /^General conversation\..*4 unread/ })
  expect(general.textContent).toContain('builder is working')
  const activity = screen.getByRole('button', { name: /^Activity feed\./ })
  expect(general.compareDocumentPosition(activity) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

  fireEvent.click(general)
  expect(await screen.findByRole('button', { name: 'Back to chats' })).toBeDefined()
  expect(screen.getByTestId('params').textContent).toContain('job=job-default')
  expect(screen.getByRole('combobox', { name: /^Message Team room/ })).toBeDefined()
})

// was: 'opening a phone job pushes history, so Back returns to the list instead of leaving /b'
test('opening a phone topic pushes history, so Back returns to All topics instead of leaving /b', async () => {
  stubRoom([makeJob({ id: 'job-activity', title: 'Activity feed' })])
  renderInRoom(
    <>
      <BoldTeamRoom agents={agents} phone />
      <HistoryBack />
    </>,
    ['/b?jobs=1'],
  )

  fireEvent.click(await screen.findByRole('button', { name: /^Activity feed\./ }))
  expect(await screen.findByRole('button', { name: 'Back to chats' })).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: 'History back' }))
  expect(await screen.findByRole('heading', { name: 'All topics' })).toBeDefined()
  expect(screen.queryByRole('button', { name: 'Back to chats' })).toBeNull()
})

// was: 'a missing phone job shows the list with a short note, never a Back header'
test('a missing phone topic shows All topics with a short note, never a Back header', async () => {
  stubRoom([makeJob({ id: 'job-activity', title: 'Activity feed' })])
  renderInRoom(<BoldTeamRoom agents={agents} phone />, ['/b?job=job-deleted'])

  expect(await screen.findByText('That job isn’t here any more.')).toBeDefined()
  expect(await screen.findByRole('heading', { name: 'All topics' })).toBeDefined()
  expect(screen.queryByRole('button', { name: 'Back to jobs' })).toBeNull()
})

// was: 'a missing phone job in a fresh room still shows the job list, not the starter'
test('a missing phone topic in a fresh room still shows All topics, not the starter', async () => {
  stubRoom([])
  renderInRoom(<BoldTeamRoom agents={agents} phone />, ['/b?job=job-deleted'])

  expect(await screen.findByText('That job isn’t here any more.')).toBeDefined()
  expect(screen.getByRole('heading', { name: 'All topics' })).toBeDefined()
  expect(screen.queryByRole('heading', { name: 'Your team is ready. What first?' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Back to jobs' })).toBeNull()
})

// was: 'selecting a job changes the composer destination and hides the message param'
test('the context bar follows the topic picked in the address, else the newest open one, else the general conversation', async () => {
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
  const first = renderInRoom(<BoldTeamRoom agents={agents} />, ['/b?job=job-old&message=old'])
  expect((await screen.findByLabelText('Where this message goes')).textContent).toContain(
    'in Old work',
  )
  first.unmount()

  const second = renderInRoom(<BoldTeamRoom agents={agents} />, ['/b'])
  await waitFor(() =>
    expect(screen.getByLabelText('Where this message goes').textContent).toContain(
      'in Activity feed',
    ),
  )
  second.unmount()

  // With every topic finished, a message goes to the general conversation: no "in …".
  stubRoom([
    makeJob({ id: 'job-default', title: 'Team room', isDefault: true }),
    makeJob({ id: 'job-old', title: 'Old work', state: 'done' }),
  ])
  renderInRoom(<BoldTeamRoom agents={agents} />, ['/b'])
  await screen.findByRole('separator', { name: 'Topic: Old work, done' })
  expect(screen.getByLabelText('Where this message goes').textContent).not.toContain(' in ')
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
test('renaming a topic from its divider sends PATCH with the trimmed title and relabels the divider', async () => {
  const fetchMock = stubRoom([makeJob({ id: 'job-activity', title: 'Activity feed' })])
  const fallback = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation(async (input, init) => {
    if (String(input) === '/api/jobs/job-activity' && init?.method === 'PATCH')
      return jsonResponse(makeJob({ id: 'job-activity', title: 'Activity feed v2' }))
    return fallback(input, init)
  })
  renderInRoom(<BoldTeamRoom agents={agents} />, ['/b?job=job-activity'])
  await screen.findByRole('separator', { name: 'Topic: Activity feed, working' })
  fireEvent.click(within(topicDivider('Activity feed')).getByRole('button', { name: 'Job menu' }))
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
  expect(screen.getByRole('separator', { name: 'Topic: Activity feed v2, working' })).toBeDefined()
  expect(screen.queryByRole('separator', { name: 'Topic: Activity feed, working' })).toBeNull()
})

// was: 'delete asks for the typed title, then offers a 10-second undo that restores'
test('deleting a topic asks for its typed title, takes its divider away, and Undo brings it back', async () => {
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
  await screen.findByRole('separator', { name: 'Topic: Activity feed, working' })
  fireEvent.click(within(topicDivider('Activity feed')).getByRole('button', { name: 'Job menu' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete job' }))
  const confirm = screen.getByRole('button', { name: 'Delete job' })
  expect((confirm as HTMLButtonElement).disabled).toBe(true)
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Activity feed' } })
  expect((confirm as HTMLButtonElement).disabled).toBe(false)
  fireEvent.click(confirm)
  expect(await screen.findByText(/Job deleted/)).toBeDefined()
  expect(screen.queryByRole('separator', { name: /^Topic: Activity feed/ })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
  await waitFor(() =>
    expect(lastRequest(fetchMock, '/api/jobs/job-activity/restore', 'POST')).toBeDefined(),
  )
  expect(await screen.findByText('Restored “Activity feed”.')).toBeDefined()
  expect(
    await screen.findByRole('separator', { name: 'Topic: Activity feed, working' }),
  ).toBeDefined()
})

// was: 'closing a job posts close and tells the person where to find it'
test('closing a topic posts close, says how to reopen it, and its divider reads closed', async () => {
  const fetchMock = stubRoom([makeJob({ id: 'job-activity', title: 'Activity feed' })])
  const fallback = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation(async (input, init) => {
    if (String(input) === '/api/jobs/job-activity/close' && init?.method === 'POST')
      return jsonResponse(makeJob({ id: 'job-activity', state: 'closed' }))
    return fallback(input, init)
  })
  renderInRoom(<BoldTeamRoom agents={agents} />, ['/b?job=job-activity'])
  await screen.findByRole('separator', { name: 'Topic: Activity feed, working' })

  fireEvent.click(within(topicDivider('Activity feed')).getByRole('button', { name: 'Job menu' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Close' }))

  expect(
    await screen.findByText('Closed “Activity feed”. Reopen it from its topic menu.'),
  ).toBeDefined()
  // It stays in the conversation as a closed topic: nothing disappears into a hidden list.
  expect(
    await screen.findByRole('separator', { name: 'Topic: Activity feed, closed' }),
  ).toBeDefined()
  const call = lastRequest(fetchMock, '/api/jobs/job-activity/close', 'POST')
  expect(call).toBeDefined()
  expect(new Headers(call?.[1]?.headers).get('Idempotency-Key')).toBeTruthy()
})

// was: 'a closed job is listed under Closed jobs and its menu reopens it'
test('a closed topic keeps its divider and its menu reopens it', async () => {
  const fetchMock = stubRoom([
    makeJob({ id: 'job-closed', title: 'Old import', state: 'closed' }),
    makeJob({ id: 'job-activity', title: 'Activity feed' }),
  ])
  const fallback = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation(async (input, init) => {
    if (String(input) === '/api/jobs/job-closed/reopen' && init?.method === 'POST')
      return jsonResponse(makeJob({ id: 'job-closed', title: 'Old import', state: 'open' }))
    return fallback(input, init)
  })
  renderInRoom(<BoldTeamRoom agents={agents} />, ['/b?job=job-activity'])

  await screen.findByRole('separator', { name: 'Topic: Old import, closed' })
  fireEvent.click(within(topicDivider('Old import')).getByRole('button', { name: 'Job menu' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Reopen' }))

  expect(await screen.findByText('Reopened “Old import”.')).toBeDefined()
  expect(await screen.findByRole('separator', { name: 'Topic: Old import, open' })).toBeDefined()
  expect(lastRequest(fetchMock, '/api/jobs/job-closed/reopen', 'POST')).toBeDefined()
  // Reopening makes it the current topic.
  expect(screen.getByLabelText('Where this message goes').textContent).toContain('in Old import')
})

// was: 'a closed job from the server snapshot is under Closed jobs after a reload'
test('a topic that is closed in the server snapshot is a closed divider after a reload, and can be reopened', async () => {
  const closed = makeJob({ id: 'job-closed', title: 'Old import', state: 'closed' })
  const fetchMock = stubRoom([closed, makeJob({ id: 'job-activity', title: 'Activity feed' })])
  const fallback = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation(async (input, init) => {
    if (String(input) === '/api/jobs/job-closed/reopen' && init?.method === 'POST')
      return jsonResponse({ ...closed, state: 'open' })
    return fallback(input, init)
  })
  renderInRoom(<BoldTeamRoom agents={agents} />, ['/b'])

  expect(await screen.findByRole('separator', { name: 'Topic: Old import, closed' })).toBeDefined()
  fireEvent.click(within(topicDivider('Old import')).getByRole('button', { name: 'Job menu' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Reopen' }))
  expect(await screen.findByText('Reopened “Old import”.')).toBeDefined()
})

// was: 'a job.deleted event returns the open job to All with a note'
test('a job.deleted event takes the open topic out of the conversation, clears ?job= and says why', async () => {
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
  expect(screen.getByRole('separator', { name: 'Topic: Release notes, working' })).toBeDefined()
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

// was: 'the phone job list keeps closed jobs behind a Closed jobs entry'
test('the phone All topics list keeps closed topics behind a Closed topics entry', async () => {
  stubRoom([
    makeJob({ id: 'job-closed', title: 'Old import', state: 'closed' }),
    makeJob({ id: 'job-activity', title: 'Activity feed' }),
  ])
  renderInRoom(<BoldTeamRoom agents={agents} phone />, ['/b?jobs=1'])

  expect(await screen.findByRole('button', { name: /^Activity feed\./ })).toBeDefined()
  expect(screen.queryByRole('button', { name: /^Old import\./ })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Closed topics (1)' }))
  expect(await screen.findByRole('heading', { name: 'Closed topics' })).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: /^Old import\./ }))
  expect(await screen.findByRole('button', { name: 'Back to chats' })).toBeDefined()
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
  for (const name of [
    '/new',
    '/rename',
    '/done',
    '/reopen',
    '/lead',
    '/add',
    '/remove',
    '/workspace',
  ])
    expect(names()).toContain(name)
  // Each entry carries its one-line description.
  expect(within(palette).getByRole('option', { name: /\/done/ }).textContent).toContain(
    'Close the current topic',
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

test('/new makes a topic, selects it, says so in the stream and clears the composer', async () => {
  const fetchMock = stubRoom([makeJob({ id: 'job-1', title: 'Activity feed' })])
  const fallback = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation(async (input, init) => {
    if (String(input) === '/api/rooms/room-1/jobs' && init?.method === 'POST')
      return jsonResponse(makeJob({ id: 'job-new', title: 'Fix login', state: 'open' }))
    return fallback(input, init)
  })
  renderInRoom(
    <>
      <BoldTeamRoom agents={agents} />
      <ParamsProbe />
    </>,
    ['/b'],
  )
  const composer = (await screen.findByRole('combobox', {
    name: /^Message Team room/,
  })) as HTMLTextAreaElement
  fireEvent.change(composer, { target: { value: '/new Fix login' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  expect(await screen.findByText('You started the topic “Fix login”')).toBeDefined()
  expect(screen.getByTestId('params').textContent).toContain('job=job-new')
  await waitFor(() => expect(composer.value).toBe(''))
  expect(lastRequest(fetchMock, '/api/rooms/room-1/jobs', 'POST')).toBeDefined()
  // Nothing was posted as a chat message.
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
  expect(held.placeholder).toBe('Loading the topic…')
  release()
  await waitFor(() => expect(held.disabled).toBe(false), { timeout: 4000 })
})
