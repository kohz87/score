import { fireEvent, screen, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import type { OutsideSession } from '@score/contract'
import {
  agents,
  jsonResponse,
  makeJob,
  mockFetch,
  openOtherRooms,
  renderInRoom,
  room,
} from './room-test-utils.tsx'
import { BoldTeamRoom } from './BoldTeamRoom.tsx'
import {
  importedRoom,
  ParamsProbe,
  phoneApproval,
  setupRoomTest,
  stubRoom,
} from './BoldTeamRoom-helpers.tsx'

setupRoomTest()

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
