import { fireEvent, screen, waitFor } from '@testing-library/react'
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

  fireEvent.click(await screen.findByRole('button', { name: /^Team room/ }))
  const picker = await screen.findByRole('listbox', { name: 'Rooms and chats elsewhere' })
  expect(picker.textContent).toContain('Imported chats')
  expect(picker.textContent).toContain('Imported from Telegram · read-write')
  expect(picker.textContent).toContain('#telegram-plan')
})

test('the room dropdown closes when Tab moves focus outside it', async () => {
  stubRoom([makeJob()], { older: true })
  renderInRoom(<BoldTeamRoom agents={agents} />, ['/b'])

  fireEvent.click(await screen.findByRole('button', { name: /^Team room/ }))
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

  fireEvent.click(await screen.findByRole('button', { name: /^Team room/ }))
  fireEvent.click(await screen.findByRole('option', { name: /#telegram-plan/ }))
  await waitFor(() =>
    expect(screen.getByRole('button', { name: /^#telegram-plan #imported/ })).toBeDefined(),
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

  fireEvent.click(await screen.findByRole('button', { name: /^Team room/ }))
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
