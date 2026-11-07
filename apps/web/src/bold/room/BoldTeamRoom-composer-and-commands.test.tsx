import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { agents, jsonResponse, makeJob, makeMessage, renderInRoom } from './room-test-utils.tsx'
import { BoldTeamRoom } from './BoldTeamRoom.tsx'
import { lastRequest, ParamsProbe, setupRoomTest, stubRoom } from './BoldTeamRoom-helpers.tsx'

setupRoomTest()

/** The divider that opens a topic, found by the title it carries. */
function topicDivider(title: string) {
  const found = screen
    .getAllByRole('separator')
    .find((item) => item.getAttribute('aria-label')?.startsWith(`Topic: ${title},`))
  if (!found) throw new Error(`No divider for the topic ${title}`)
  return found
}

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
