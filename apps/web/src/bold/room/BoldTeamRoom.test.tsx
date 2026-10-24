import { fireEvent, screen, waitFor } from '@testing-library/react'
import { useNavigate, useSearchParams } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { Approval, OutsideSession, Room } from '@score/contract'
import {
  agents,
  disposeRoomTest,
  jsonResponse,
  makeJob,
  mockFetch,
  renderInRoom,
  room,
} from './room-test-utils.tsx'
import { BoldTeamRoom } from './BoldTeamRoom.tsx'

beforeEach(() => {
  window.localStorage.clear()
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
  } = {},
) {
  const fetchMock = mockFetch((url, init) => {
    const parsed = new URL(url, 'http://x')
    if (parsed.pathname === '/api/team-room') return jsonResponse({ asOfSeq: 1, room, jobs })
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
      return jsonResponse({ asOfSeq: 1, items: [] })
    if (parsed.pathname === '/api/approvals')
      return jsonResponse({ asOfSeq: 1, items: options.approvals ?? [], nextCursor: null })
    if (parsed.pathname === '/api/commands') return jsonResponse({ items: [] })
    if (parsed.pathname.startsWith('/api/jobs/')) return jsonResponse({ asOfSeq: 1, items: [] })
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

test('the room shows job tabs, the To chip and the seeded unread count', async () => {
  stubRoom([
    makeJob({ id: 'job-1', title: 'Activity feed', unread: 2 }),
    makeJob({ id: 'job-2', title: 'Release notes', unread: 3 }),
  ])
  renderInRoom(<BoldTeamRoom agents={agents} />, ['/b'])
  await screen.findByRole('tab', { name: /Activity feed/ })
  expect(screen.getByRole('tab', { name: /^All/ }).textContent).toContain('5')
  expect(screen.getByText('To: team room (lead)')).toBeDefined()
  expect(screen.getByRole('button', { name: 'Needs you' })).toBeDefined()
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

test('a phone opens on board 18 with the pinned request first, then jobs and their unread counts', async () => {
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
  renderInRoom(<BoldTeamRoom agents={agents} phone />, ['/b'])

  expect(await screen.findByRole('heading', { name: 'Jobs' })).toBeDefined()
  expect(screen.queryByRole('tablist', { name: 'Jobs' })).toBeNull()
  const teamRow = screen.getByRole('button', { name: /^Team room\..*9 unread/ })
  expect(teamRow.textContent).toContain('builder is working')
  expect(
    screen.getByRole('combobox', { name: /^Message Team room/ }).getAttribute('placeholder'),
  ).toBe('Start a job or message the team')
  const activity = screen.getByRole('button', { name: /^Activity feed\..*2 unread/ })
  const notes = screen.getByRole('button', { name: /^Release notes 2\.4\..*3 unread/ })
  expect(activity.compareDocumentPosition(notes) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(teamRow.compareDocumentPosition(activity) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(activity.textContent).toContain('builder is working')
  expect(notes.textContent).toContain('lead needs you')
  expect(screen.getByRole('img', { name: 'Done' })).toBeDefined()

  const pin = await screen.findByRole('article', {
    name: /Needs you: May I install a package/,
  })
  expect(pin.getAttribute('data-protected')).toBe('flex')
  const jobs = screen.getByRole('region', { name: 'Jobs' })
  expect(pin.compareDocumentPosition(jobs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
})

test('a phone opens a job full screen and Back returns to the job list', async () => {
  stubRoom([
    makeJob({ id: 'job-activity', title: 'Activity feed', unread: 2 }),
    makeJob({ id: 'job-notes', title: 'Release notes 2.4' }),
  ])
  renderInRoom(
    <>
      <BoldTeamRoom agents={agents} phone />
      <ParamsProbe />
    </>,
    ['/b?message=old'],
  )

  fireEvent.click(await screen.findByRole('button', { name: /^Activity feed\./ }))
  expect(await screen.findByText('To: Activity feed')).toBeDefined()
  await waitFor(() =>
    expect(screen.getByText('Activity feed', { selector: '[data-phone-chat-title]' })).toBe(
      document.activeElement,
    ),
  )
  expect(screen.getByTestId('params').textContent).toContain('job=job-activity')
  expect(screen.getByTestId('params').textContent).not.toContain('message')
  expect(screen.queryByRole('heading', { name: 'Jobs' })).toBeNull()
  expect(screen.getByText('Activity feed')).toBeDefined()
  expect(
    screen.getByRole('combobox', { name: /^Message Team room/ }).getAttribute('placeholder'),
  ).toBe('Message the team')
  expect(screen.getByRole('button', { name: /Open thread for Activity feed/ })).toBeDefined()

  fireEvent.click(screen.getByRole('button', { name: 'Back to jobs' }))
  expect(await screen.findByRole('heading', { name: 'Jobs' })).toBeDefined()
  expect(screen.getByTestId('params').textContent).not.toContain('job=')
  await waitFor(() =>
    expect(screen.getByRole('button', { name: /^Activity feed\./ })).toBe(document.activeElement),
  )
})

test('the phone list puts the default Team room row first and opens its chat', async () => {
  stubRoom([
    makeJob({ id: 'job-default', title: 'Team room', isDefault: true, unread: 4 }),
    makeJob({ id: 'job-activity', title: 'Activity feed', unread: 2 }),
  ])
  renderInRoom(
    <>
      <BoldTeamRoom agents={agents} phone />
      <ParamsProbe />
    </>,
    ['/b'],
  )

  const teamRow = await screen.findByRole('button', { name: /^Team room\..*4 unread/ })
  expect(teamRow.textContent).toContain('builder is working')
  const activity = screen.getByRole('button', { name: /^Activity feed\./ })
  expect(teamRow.compareDocumentPosition(activity) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

  fireEvent.click(teamRow)
  expect(
    await screen.findByText('builder is working', { selector: '.bold-phone-chat-id span' }),
  ).toBeDefined()
  expect(screen.getByTestId('params').textContent).toContain('job=job-default')
  expect(screen.getByRole('button', { name: 'Back to jobs' })).toBeDefined()
  expect(screen.getByRole('combobox', { name: /^Message Team room/ })).toBeDefined()
})

test('opening a phone job pushes history, so Back returns to the list instead of leaving /b', async () => {
  stubRoom([makeJob({ id: 'job-activity', title: 'Activity feed' })])
  renderInRoom(
    <>
      <BoldTeamRoom agents={agents} phone />
      <HistoryBack />
    </>,
    ['/b'],
  )

  fireEvent.click(await screen.findByRole('button', { name: /^Activity feed\./ }))
  expect(await screen.findByRole('button', { name: 'Back to jobs' })).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: 'History back' }))
  expect(await screen.findByRole('heading', { name: 'Jobs' })).toBeDefined()
  expect(screen.queryByRole('button', { name: 'Back to jobs' })).toBeNull()
})

test('a missing phone job shows the list with a short note, never a Back header', async () => {
  stubRoom([makeJob({ id: 'job-activity', title: 'Activity feed' })])
  renderInRoom(<BoldTeamRoom agents={agents} phone />, ['/b?job=job-deleted'])

  expect(await screen.findByText('That job isn’t here any more.')).toBeDefined()
  expect(await screen.findByRole('heading', { name: 'Jobs' })).toBeDefined()
  expect(screen.queryByRole('button', { name: 'Back to jobs' })).toBeNull()
})

test('a missing phone job in a fresh room still shows the job list, not the starter', async () => {
  stubRoom([])
  renderInRoom(<BoldTeamRoom agents={agents} phone />, ['/b?job=job-deleted'])

  expect(await screen.findByText('That job isn’t here any more.')).toBeDefined()
  expect(screen.getByRole('heading', { name: 'Jobs' })).toBeDefined()
  expect(screen.queryByRole('heading', { name: 'Your team is ready. What first?' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Back to jobs' })).toBeNull()
})

test('an older phone room with no messages still opens its chat, not the starter', async () => {
  stubRoom([makeJob({ id: 'job-1', title: 'Activity feed' })], { older: true })
  renderInRoom(<BoldTeamRoom agents={agents} phone />, ['/b?room=room-old'])

  expect(await screen.findByRole('button', { name: 'Back to the team room' })).toBeDefined()
  expect(screen.getByRole('combobox', { name: /^Message #activity-feed/ })).toBeDefined()
  expect(screen.queryByRole('heading', { name: 'Your team is ready. What first?' })).toBeNull()
})

test('an older room opens straight into its phone chat and Back returns to the team room', async () => {
  stubRoom([makeJob({ id: 'job-1', title: 'Activity feed' })], { older: true })
  renderInRoom(
    <>
      <BoldTeamRoom agents={agents} phone />
      <ParamsProbe />
    </>,
    ['/b?room=room-old'],
  )

  expect(await screen.findByRole('button', { name: 'Back to the team room' })).toBeDefined()
  expect(screen.getByText('#activity-feed', { selector: '.bold-phone-chat-id b' })).toBeDefined()
  expect(screen.getByRole('combobox', { name: /^Message #activity-feed/ })).toBeDefined()
  expect(screen.queryByRole('heading', { name: 'Jobs' })).toBeNull()

  fireEvent.click(screen.getByRole('button', { name: 'Back to the team room' }))
  expect(await screen.findByRole('heading', { name: 'Jobs' })).toBeDefined()
  expect(screen.getByTestId('params').textContent).not.toContain('room=')
})

test('selecting a job changes the composer destination and hides the message param', async () => {
  stubRoom([makeJob({ id: 'job-1', title: 'Activity feed' })])
  renderInRoom(<BoldTeamRoom agents={agents} />, ['/b?job=job-1&message=old'])
  expect(await screen.findByText('To: Activity feed')).toBeDefined()
  fireEvent.click(screen.getByRole('tab', { name: /^All/ }))
  expect(await screen.findByText('To: team room (lead)')).toBeDefined()
})

test('opening the room reads only the jobs on screen, and a second job waits for its tab', async () => {
  const activity = makeJob({ id: 'job-activity', title: 'Activity feed', unread: 4 })
  const defaultJob = makeJob({
    id: 'job-default',
    title: 'Team room',
    isDefault: true,
    unread: 0,
  })
  const fetchMock = stubRoom([defaultJob, activity])
  renderInRoom(<BoldTeamRoom agents={agents} />, ['/b'])

  const activityTab = await screen.findByRole('tab', { name: /Activity feed/ })
  expect(activityTab.textContent).toContain('4')
  await waitFor(() =>
    expect(
      fetchMock.mock.calls.some(
        ([url]) => String(url).includes('/messages?') && String(url).includes('jobId=job-default'),
      ),
    ).toBe(true),
  )
  expect(
    fetchMock.mock.calls.some(
      ([url]) => String(url).includes('/messages?') && String(url).includes('jobId=job-activity'),
    ),
  ).toBe(false)

  fireEvent.click(screen.getByRole('tab', { name: /Activity feed/ }))
  await waitFor(() =>
    expect(
      fetchMock.mock.calls.some(
        ([url]) => String(url).includes('/messages?') && String(url).includes('jobId=job-activity'),
      ),
    ).toBe(true),
  )
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

test('the room dropdown opens an older room read-write with today’s @mention routing', async () => {
  const fetchMock = stubRoom([makeJob({ id: 'job-1', title: 'Activity feed' })], { older: true })
  renderInRoom(<BoldTeamRoom agents={agents} />, ['/b'])

  fireEvent.click(await screen.findByRole('button', { name: /^Team room/ }))
  const picker = await screen.findByRole('listbox', { name: 'Rooms and chats elsewhere' })
  await screen.findByRole('option', { name: /#activity-feed/ })
  expect(picker.textContent).toContain('Always on · 1 job')
  expect(picker.textContent).toContain('Older room · read-write with @mentions')
  fireEvent.click(screen.getByRole('option', { name: /#activity-feed/ }))

  expect(await screen.findByText('Older room · @name')).toBeDefined()
  expect(screen.queryByRole('button', { name: 'Start a job' })).toBeNull()
  const composer = await screen.findByRole('combobox', { name: /^Message #activity-feed/ })
  fireEvent.change(composer, { target: { value: '@builder Where is the feed?' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))

  await waitFor(() => {
    const sent = fetchMock.mock.calls.find(
      ([url, init]) => String(url) === '/api/rooms/room-old/messages' && init?.method === 'POST',
    )
    expect(sent).toBeDefined()
    expect(JSON.parse(String(sent?.[1]?.body))).toMatchObject({
      text: '@builder Where is the feed?',
    })
  })
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

test('the selected job’s menu offers the contract’s share and classic room export', async () => {
  stubRoom([makeJob({ id: 'job-activity', title: 'Activity feed' })])
  renderInRoom(<BoldTeamRoom agents={agents} />, ['/b?job=job-activity'])

  fireEvent.click(await screen.findByRole('button', { name: 'Job menu' }))
  const menu = await screen.findByRole('menu', { name: 'Activity feed actions' })
  expect(menu.textContent).toContain('Share a read-only link')
  expect(menu.textContent).toContain('Export the whole room as Markdown')
  expect(screen.getAllByRole('menuitem').every((item) => item.classList.contains('mi'))).toBe(true)
  // The contract has no job rename, close or delete; those prototype items are reported as gaps, not faked here.
  expect(menu.textContent).not.toContain('Rename')
  expect(menu.textContent).not.toContain('Delete job')
  fireEvent.click(screen.getByRole('menuitem', { name: 'Share a read-only link' }))
  const dialog = await screen.findByRole('dialog')
  expect(dialog.textContent).toContain('Share Activity feed')
  expect(dialog.textContent).toContain('the job’s messages')
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
